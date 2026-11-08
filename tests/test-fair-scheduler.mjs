import assert from 'node:assert/strict';
import Engine from '../engine/portal-workshop-engine.mjs';

const branchIds = ['A', 'B', 'C', 'D'];
function expand(node) {
  if (node.path === 'root') return branchIds.map((id, index) => ({ id, area: 100 - index, priority: index }));
  const id = node.rootBranch;
  return [{ id: `${id}-${node.depth + 1}`, area: 100, priority: 0 }];
}
const result = Engine.fairSchedule({ path: 'root' }, expand, { maxCopies: 21, maxDepth: 99 });
assert.equal(result.stats.scheduler, 'breadth-fair-v1');
assert.equal(result.stats.copies, 21);
assert.equal(result.stats.conservativeTerminal, true);
for (const id of branchIds) assert(id in result.stats.branchDepths, `missing branch ${id}`);
assert(result.stats.fairnessSpan <= 1, `branch depth span was ${result.stats.fairnessSpan}`);
assert(result.terminals.length > 0, 'finite capacity must produce explicit terminals');
assert(result.terminals.every(t => ['capacity', 'depth'].includes(t.reason)));

const again = Engine.fairSchedule({ path: 'root' }, expand, { maxCopies: 21, maxDepth: 99 });
assert.deepEqual(again, result, 'fair scheduling must be deterministic');

const depthLimited = Engine.fairSchedule({ path: 'root' }, expand, { maxCopies: 100, maxDepth: 2 });
assert(depthLimited.terminals.some(t => t.reason === 'depth'));
assert.equal(depthLimited.stats.maxBranchDepth, 2);
assert.equal(depthLimited.stats.fairnessSpan, 0);

const capacityOne = Engine.fairSchedule({ path: 'root' }, expand, { maxCopies: 1, maxDepth: 10 });
assert.equal(capacityOne.copies.length, 1);
assert.equal(capacityOne.terminals.length, 4);
assert(capacityOne.terminals.every(t => t.reason === 'capacity'));

// Demonstrate the regression oracle: a naïve depth-first global cap starves siblings.
function naiveDfs(maxCopies) {
  const stack = [{ path: 'root', depth: 0, rootBranch: null }], depths = {};
  let copies = 0;
  while (stack.length && copies < maxCopies) {
    const node = stack.pop(); copies++;
    if (node.rootBranch) depths[node.rootBranch] = Math.max(depths[node.rootBranch] || 0, node.depth);
    const children = expand(node);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i], rootBranch = node.rootBranch || child.id;
      stack.push({ ...child, path: `${node.path}/${child.id}`, depth: node.depth + 1, rootBranch });
    }
  }
  return depths;
}
const starved = naiveDfs(21);
assert(Object.keys(starved).length < branchIds.length, 'the negative oracle should expose DFS starvation');

console.log('PASS test-fair-scheduler', result.stats);
