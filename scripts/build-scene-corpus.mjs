#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Engine from '../engine/portal-workshop-engine.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const colors={cyan:[0.04732,0.56007,0.68342],orange:[0.64951,0.29542,0.03271],violet:[0.46,0.22,0.86],lime:[0.14,0.72,0.29]};
const portal=(id,pairId,targetId,shape,position,rotation,size,color,priority)=>({id,pairId,targetId,shape,position,rotation,size,color,enabled:true,locked:false,priority});
const base=(id,name,player,portals,compressedSpaces=[])=>Engine.normalizeScene({id,name,selectedId:portals[0]?.id||compressedSpaces[0]?.id||'',player,settings:{fov:Math.PI/2,portalDistance:1,roomSize:[4,4,4]},portals,compressedSpaces});
const scenes=[
 base('basic-pair','Basic reciprocal rectangle pair',{x:1.1,y:.1,z:-.4,yaw:-2.53,pitch:-.05},[
  portal('A','pair1','B','rectangle',[0,0,-2.05],[0,0,0],[2,4],colors.cyan,0),
  portal('B','pair1','A','rectangle',[0,0,2.05],[0,Math.PI,0],[2,4],colors.orange,1)
 ]),
 base('simultaneous-loops','Two simultaneously visible reciprocal loops',{x:0,y:0,z:0,yaw:0,pitch:0},[
  portal('A','left','B','rectangle',[-1.25,0,-2.05],[0,0,0],[1.35,3.4],colors.cyan,0),
  portal('B','left','A','rectangle',[-1.25,0,2.05],[0,Math.PI,0],[1.35,3.4],colors.orange,1),
  portal('C','right','D','rectangle',[1.25,0,-2.05],[0,0,0],[1.35,3.4],colors.violet,2),
  portal('D','right','C','rectangle',[1.25,0,2.05],[0,Math.PI,0],[1.35,3.4],colors.lime,3)
 ]),
 base('overlap-ownership','Coincident apertures with deterministic ownership',{x:0,y:0,z:0,yaw:0,pitch:0},[
  portal('A','primary','B','rectangle',[0,0,2.05],[0,Math.PI,0],[2.4,3.5],colors.cyan,0),
  portal('B','primary','A','rectangle',[-2.05,0,0],[0,-Math.PI/2,0],[2.4,3.5],colors.orange,1),
  portal('C','secondary','D','rectangle',[0,0,2.05],[0,Math.PI,0],[2.4,3.5],colors.violet,2),
  portal('D','secondary','C','rectangle',[2.05,0,0],[0,Math.PI/2,0],[2.4,3.5],colors.lime,3)
 ]),
 base('boundary-contact','Camera on a portal plane boundary',{x:0,y:0,z:2.05,yaw:Math.PI,pitch:0},[
  portal('A','pair1','B','rectangle',[0,0,-2.05],[0,0,0],[2.4,3.6],colors.cyan,0),
  portal('B','pair1','A','rectangle',[0,0,2.05],[0,Math.PI,0],[2.4,3.6],colors.orange,1)
 ]),
 base('mixed-shapes','Rectangle, circle, oval, and triangle pairs',{x:0,y:.1,z:0,yaw:0,pitch:0},[
  portal('A','circle-pair','B','circle',[-1.45,.65,2.05],[0,Math.PI,0],[1.2,1.2],colors.cyan,0),
  portal('B','circle-pair','A','oval',[-1.45,.65,-2.05],[0,0,0],[2,1],colors.orange,1),
  portal('C','triangle-pair','D','triangle',[1.35,-.45,2.05],[0,Math.PI,0],[1.7,1.7],colors.violet,2),
  portal('D','triangle-pair','C','rectangle',[1.35,-.45,-2.05],[0,0,0],[1.25,2.2],colors.lime,3)
 ]),
 base('scaled-rotated','Differently sized and rotated portal endpoints',{x:-.3,y:0,z:-.2,yaw:.15,pitch:-.03},[
  portal('A','scale','B','oval',[-1.1,.25,-2.05],[0,0,.18],[1.1,2.9],colors.cyan,0),
  portal('B','scale','A','oval',[1.25,-.3,2.05],[0,Math.PI,-.33],[2.7,1.15],colors.orange,1)
 ]),
 base('editor-fixture','Editor lifecycle fixture',{x:.5,y:.15,z:-.75,yaw:-2.8,pitch:-.08},[
  portal('A','pair1','B','rectangle',[0,0,-2.05],[0,0,0],[2,4],colors.cyan,0),
  portal('B','pair1','A','rectangle',[0,0,2.05],[0,Math.PI,0],[2,4],colors.orange,1),
  portal('C','pair2','D','triangle',[-2.05,.4,0],[0,-Math.PI/2,.2],[1.5,1.8],colors.violet,2),
  portal('D','pair2','C','circle',[2.05,-.3,0],[0,Math.PI/2,0],[1.4,1.4],colors.lime,3)
 ]),
 base('compressed-opt-in','Opt-in bounded compressed-space extension',{x:1.1,y:.1,z:-.4,yaw:-2.53,pitch:-.05},[
  portal('A','pair1','B','rectangle',[0,0,-2.05],[0,0,0],[2,4],colors.cyan,0),
  portal('B','pair1','A','rectangle',[0,0,2.05],[0,Math.PI,0],[2,4],colors.orange,1)
 ],[{id:'c1',kind:'compressed',label:'Compressed Space',position:[0,0,0],rotation:[0,0,0],size:[1.8,1.8,1.8],scale:[1,1,.35],tint:[.58,.93,1],enabled:true,locked:false}])
];
const corpus={schema:'portal-workshop-scene-corpus',version:Engine.CORPUS_VERSION,engineVersion:Engine.VERSION,createdUtc:'2026-08-19T00:00:00Z',scenes:scenes.map((scene,index)=>({index,id:scene.id,name:scene.name,fingerprint:Engine.sceneFingerprint(scene),scene}))};
fs.writeFileSync(path.join(root,'fixtures/scenes-v1.json'),JSON.stringify(corpus,null,2)+'\n');
const forward=p=>[Math.sin(p.yaw)*Math.cos(p.pitch),Math.sin(p.pitch),Math.cos(p.yaw)*Math.cos(p.pitch)];
const oracles={schema:'portal-workshop-oracles',version:'1.0.0',sceneCorpusVersion:corpus.version,renderer:{canonical:'euclidean-unfolded-raster-breadth-fair-v1',finiteDepth:2048,maxCopies:4097,conservativeTerminal:true},scenes:{}};
for(const entry of corpus.scenes){
 const s=entry.scene,origin=[s.player.x,s.player.y,s.player.z],direction=forward(s.player),ray=Engine.traceRay(s,origin,direction,{maxEvents:48});
 oracles.scenes[entry.id]={fingerprint:entry.fingerprint,pixel:{viewport:[640,360],golden:`oracles/${entry.id}.png`,tolerance:{maxDifferentPixels:0,maxChannelDelta:0},environment:'Chromium 144 / ANGLE SwiftShader release oracle'},depth:{ray:{origin,direction},expected:{resolved:ray.resolved,face:ray.face,crossings:ray.crossings,travel:Number(ray.travel.toFixed(7)),truncated:ray.truncated}},movement:{from:origin,delta:direction.map(v=>v*1.25),expected:Engine.traceMovement(s,origin,direction.map(v=>v*1.25),{maxCrossings:16})},crossing:{deterministicOwner:entry.id==='overlap-ownership'?'A':null},resize:{viewports:[[640,360],[1024,768],[1440,900]]},editor:{required:entry.id==='editor-fixture'},lifecycle:{contextLossRestore:true,visibilityPause:true}};
}
const goldenManifestPath=path.join(root,'fixtures/oracles/MANIFEST.json');
if(fs.existsSync(goldenManifestPath)){
 try{
  const golden=JSON.parse(fs.readFileSync(goldenManifestPath,'utf8'));
  for(const [id,entry] of Object.entries(golden.scenes||{})){
   if(!oracles.scenes[id]) continue;
   Object.assign(oracles.scenes[id].pixel,{bytes:entry.bytes,pngSha256:entry.pngSha256,rgbaSha256:entry.rgbaSha256,verifiedHtmlSha256:golden.verifiedHtmlSha256});
  }
 }catch(error){
  throw new Error(`Could not preserve golden-manifest metadata: ${error.message}`);
 }
}
fs.writeFileSync(path.join(root,'fixtures/oracles-v1.json'),JSON.stringify(oracles,null,2)+'\n');
console.log(JSON.stringify({scenes:corpus.scenes.length,corpus:path.join(root,'fixtures/scenes-v1.json'),oracles:path.join(root,'fixtures/oracles-v1.json'),goldenMetadataPreserved:fs.existsSync(goldenManifestPath)},null,2));
