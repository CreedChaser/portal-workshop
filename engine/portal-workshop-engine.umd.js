/* Portal Workshop Engine Core 1.0.0
 * Dependency-free scene, traversal, deterministic ownership, and fair work API.
 * UMD/global build for the standalone workshop. MIT-style project code; see
 * THIRD_PARTY_NOTICES.md for bundled upstream notices.
 */
(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PortalWorkshopEngine=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var VERSION='1.0.0';
  var SCENE_VERSION=2;
  var CORPUS_VERSION='1.0.0';
  var SHAPES=new Set(['rectangle','circle','oval','triangle']);
  var runtimeAdapter=null;
  var EPS=1e-9;

  function finite(value,fallback){value=Number(value);return Number.isFinite(value)?value:fallback;}
  function clamp(value,min,max){return Math.max(min,Math.min(max,value));}
  function vec3(value,fallback){value=Array.isArray(value)?value:fallback;return [finite(value[0],fallback[0]),finite(value[1],fallback[1]),finite(value[2],fallback[2])];}
  function vec2(value,fallback){value=Array.isArray(value)?value:fallback;return [finite(value[0],fallback[0]),finite(value[1],fallback[1])];}
  function color(value,fallback){return vec3(value,fallback).map(function(v){return clamp(v,0,1);});}
  function canonicalAngle(value){value=finite(value,0);var tau=Math.PI*2;value=((value+Math.PI)%tau+tau)%tau-Math.PI;return Object.is(value,-0)?0:value;}
  function clone(value){return value==null?value:JSON.parse(JSON.stringify(value));}
  function idText(value,fallback){var s=String(value==null?'':value).trim();return s||fallback;}
  function round(value,digits){digits=digits==null?7:digits;var p=Math.pow(10,digits);var r=Math.round(finite(value,0)*p)/p;return Object.is(r,-0)?0:r;}

  function normalizePortal(input,index){
    input=input&&typeof input==='object'?input:{};
    var shape=String(input.shape||'rectangle').toLowerCase();if(!SHAPES.has(shape))shape='rectangle';
    var size=vec2(input.size,[2,4]).map(function(v){return clamp(Math.abs(v),0.05,64);});
    return {
      id:idText(input.id,'p'+(index+1)),
      pairId:idText(input.pairId,'pair'+(Math.floor(index/2)+1)),
      targetId:idText(input.targetId,''),
      shape:shape,
      position:vec3(input.position,[0,0,0]).map(function(v){return clamp(v,-1e5,1e5);}),
      rotation:vec3(input.rotation,[0,0,0]).map(canonicalAngle),
      size:size,
      color:color(input.color,[0.25,0.65,0.95]),
      enabled:input.enabled!==false,
      locked:input.locked===true,
      priority:Math.trunc(clamp(finite(input.priority,index),-1e6,1e6))
    };
  }
  function normalizeSpace(input,index){
    input=input&&typeof input==='object'?input:{};
    return {
      id:idText(input.id,'c'+(index+1)),kind:'compressed',label:idText(input.label,'Compressed Space'),
      position:vec3(input.position,[0,0,0]),rotation:vec3(input.rotation,[0,0,0]).map(canonicalAngle),
      size:vec3(input.size,[1.8,1.8,1.8]).map(function(v){return clamp(Math.abs(v),0.25,32);}),
      scale:vec3(input.scale,[1,1,0.35]).map(function(v){return clamp(Math.abs(v),0.02,8);}),
      tint:color(input.tint,[0.58,0.93,1]),enabled:input.enabled===true,locked:input.locked===true
    };
  }
  function normalizeScene(input,options){
    options=options||{};input=input&&typeof input==='object'?input:{};
    var maxPortals=Math.max(0,Math.trunc(finite(options.maxPortals,128)));
    var maxSpaces=Math.max(0,Math.trunc(finite(options.maxCompressedSpaces,32)));
    var portals=(Array.isArray(input.portals)?input.portals:[]).slice(0,maxPortals).map(normalizePortal);
    var ids=new Set();
    portals.forEach(function(p,index){var base=p.id,n=2;while(ids.has(p.id))p.id=base+'-'+n++;ids.add(p.id);p.priority=Number.isFinite(p.priority)?p.priority:index;});
    portals.forEach(function(p,index){
      if(!p.targetId||!ids.has(p.targetId)){
        var mate=portals.find(function(q){return q.id!==p.id&&q.pairId===p.pairId;});
        p.targetId=mate?mate.id:p.id;
      }
    });
    var spaces=(Array.isArray(input.compressedSpaces)?input.compressedSpaces:[]).slice(0,maxSpaces).map(normalizeSpace);
    spaces.forEach(function(s){var base=s.id,n=2;while(ids.has(s.id))s.id=base+'-'+n++;ids.add(s.id);});
    var player=input.player&&typeof input.player==='object'?input.player:{};
    var settings=input.settings&&typeof input.settings==='object'?input.settings:{};
    var scene={
      version:SCENE_VERSION,
      id:idText(input.id,'scene'),
      name:idText(input.name,'Portal scene'),
      selectedId:idText(input.selectedId,portals[0]?portals[0].id:(spaces[0]?spaces[0].id:'')),
      player:{x:finite(player.x,1.1),y:finite(player.y,0.1),z:finite(player.z,-0.4),yaw:canonicalAngle(player.yaw==null?-2.53:player.yaw),pitch:clamp(finite(player.pitch,-0.05),-Math.PI/2+0.01,Math.PI/2-0.01),tm:Array.isArray(player.tm)&&player.tm.length===16?player.tm.map(function(v){return finite(v,0);}):null},
      settings:{fov:clamp(finite(settings.fov,Math.PI/2),0.35,Math.PI*1.4),portalDistance:clamp(finite(settings.portalDistance,1),0.25,1.75),roomSize:vec3(settings.roomSize,[4,4,4]).map(function(v){return clamp(Math.abs(v),0.25,256);})},
      portals:portals,
      compressedSpaces:spaces
    };
    if(!ids.has(scene.selectedId))scene.selectedId=portals[0]?portals[0].id:(spaces[0]?spaces[0].id:'');
    return scene;
  }
  function validateScene(input,options){
    var scene=normalizeScene(input,options),errors=[],warnings=[];
    if(!Array.isArray(input&&input.portals))warnings.push('portals was missing and normalized to an empty list');
    var ids=new Set();
    scene.portals.forEach(function(p){if(ids.has(p.id))errors.push('duplicate portal id '+p.id);ids.add(p.id);});
    scene.compressedSpaces.forEach(function(s){if(ids.has(s.id))errors.push('duplicate object id '+s.id);ids.add(s.id);});
    scene.portals.forEach(function(p){if(!ids.has(p.targetId))errors.push('portal '+p.id+' targets missing '+p.targetId);if(p.targetId===p.id)warnings.push('portal '+p.id+' is self-targeting');});
    var enabled=scene.portals.filter(function(p){return p.enabled;});
    if(enabled.length%2!==0)warnings.push('enabled portal count is odd');
    return {ok:errors.length===0,errors:errors,warnings:warnings,scene:scene};
  }

  function stableStringify(value){
    var seen=new Set();
    function visit(v){
      if(v===null||typeof v!=='object')return JSON.stringify(v);
      if(seen.has(v))throw new TypeError('cyclic value');seen.add(v);
      var out;
      if(Array.isArray(v))out='['+v.map(visit).join(',')+']';
      else out='{'+Object.keys(v).sort().map(function(k){return JSON.stringify(k)+':'+visit(v[k]);}).join(',')+'}';
      seen.delete(v);return out;
    }
    return visit(value);
  }
  function utf8Encode(text){if(typeof TextEncoder!=='undefined')return new TextEncoder().encode(text);if(typeof Buffer!=='undefined')return Uint8Array.from(Buffer.from(text,'utf8'));throw new Error('UTF-8 encoder unavailable');}
  function utf8Decode(bytes){if(typeof TextDecoder!=='undefined')return new TextDecoder().decode(bytes);if(typeof Buffer!=='undefined')return Buffer.from(bytes).toString('utf8');throw new Error('UTF-8 decoder unavailable');}
  function base64Encode(bytes){if(typeof Buffer!=='undefined')return Buffer.from(bytes).toString('base64');var s='';for(var i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);return btoa(s);}
  function base64Decode(text){if(typeof Buffer!=='undefined')return Uint8Array.from(Buffer.from(text,'base64'));var s=atob(text),out=new Uint8Array(s.length);for(var i=0;i<s.length;i++)out[i]=s.charCodeAt(i);return out;}
  function encodeScene(input){var text=stableStringify(normalizeScene(input));return base64Encode(utf8Encode(text)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
  function decodeScene(encoded){var s=String(encoded||'').replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return normalizeScene(JSON.parse(utf8Decode(base64Decode(s))));}
  function fnv1a64(text){var h=14695981039346656037n,p=1099511628211n,mask=(1n<<64n)-1n;var bytes=utf8Encode(String(text));for(var i=0;i<bytes.length;i++){h^=BigInt(bytes[i]);h=(h*p)&mask;}return h.toString(16).padStart(16,'0');}
  function sceneFingerprint(scene){return 'fnv1a64:'+fnv1a64(stableStringify(normalizeScene(scene)));}

  function quatFromEuler(rotation){
    var x=rotation[0],y=rotation[1],z=rotation[2],c1=Math.cos(x/2),c2=Math.cos(y/2),c3=Math.cos(z/2),s1=Math.sin(x/2),s2=Math.sin(y/2),s3=Math.sin(z/2);
    return [s1*c2*c3+c1*s2*s3,c1*s2*c3-s1*c2*s3,c1*c2*s3+s1*s2*c3,c1*c2*c3-s1*s2*s3];
  }
  function matIdentity(){return [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];}
  function matFromPose(position,rotation){
    var q=quatFromEuler(rotation),x=q[0],y=q[1],z=q[2],w=q[3],x2=x+x,y2=y+y,z2=z+z,xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;
    return [1-(yy+zz),xy+wz,xz-wy,0,xy-wz,1-(xx+zz),yz+wx,0,xz+wy,yz-wx,1-(xx+yy),0,position[0],position[1],position[2],1];
  }
  function matMultiply(a,b){var out=new Array(16);for(var c=0;c<4;c++)for(var r=0;r<4;r++){var v=0;for(var k=0;k<4;k++)v+=a[k*4+r]*b[c*4+k];out[c*4+r]=v;}return out;}
  function matInvertRigid(m){
    var out=[m[0],m[4],m[8],0,m[1],m[5],m[9],0,m[2],m[6],m[10],0,0,0,0,1],tx=m[12],ty=m[13],tz=m[14];
    out[12]=-(out[0]*tx+out[4]*ty+out[8]*tz);out[13]=-(out[1]*tx+out[5]*ty+out[9]*tz);out[14]=-(out[2]*tx+out[6]*ty+out[10]*tz);return out;
  }
  function transformPoint(m,p){var x=p[0],y=p[1],z=p[2],w=m[3]*x+m[7]*y+m[11]*z+m[15]||1;return [(m[0]*x+m[4]*y+m[8]*z+m[12])/w,(m[1]*x+m[5]*y+m[9]*z+m[13])/w,(m[2]*x+m[6]*y+m[10]*z+m[14])/w];}
  function transformVector(m,p){var x=p[0],y=p[1],z=p[2];return [m[0]*x+m[4]*y+m[8]*z,m[1]*x+m[5]*y+m[9]*z,m[2]*x+m[6]*y+m[10]*z];}
  function add(a,b){return [a[0]+b[0],a[1]+b[1],a[2]+b[2]];}
  function sub(a,b){return [a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
  function scale(a,s){return [a[0]*s,a[1]*s,a[2]*s];}
  function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
  function length(a){return Math.hypot(a[0],a[1],a[2]);}
  function normalize(a){var l=length(a);return l>EPS?scale(a,1/l):[0,0,0];}
  function ryPi(){return [-1,0,0,0,0,1,0,0,0,0,-1,0,0,0,0,1];}
  function portalMatrix(portal){return matFromPose(portal.position,portal.rotation);}
  function portalTeleport(source,target){return matMultiply(matMultiply(portalMatrix(target),ryPi()),matInvertRigid(portalMatrix(source)));}
  function apertureContains(portal,local,tolerance){
    tolerance=tolerance==null?1e-7:tolerance;var x=local[0],y=local[1],hx=portal.size[0]/2+tolerance,hy=portal.size[1]/2+tolerance;
    if(portal.shape==='circle'){var r=Math.min(hx,hy);return x*x+y*y<=r*r;}
    if(portal.shape==='oval')return (x*x)/(hx*hx)+(y*y)/(hy*hy)<=1;
    if(portal.shape==='triangle'){
      var ax=0,ay=hy,bx=-hx,by=-hy,cx=hx,cy=-hy;
      var d1=(x-bx)*(ay-by)-(ax-bx)*(y-by),d2=(x-cx)*(by-cy)-(bx-cx)*(y-cy),d3=(x-ax)*(cy-ay)-(cx-ax)*(y-ay);var neg=d1<-tolerance||d2<-tolerance||d3<-tolerance,pos=d1>tolerance||d2>tolerance||d3>tolerance;return !(neg&&pos);
    }
    return Math.abs(x)<=hx&&Math.abs(y)<=hy;
  }
  function portalIntersection(portal,from,to,epsilon){
    epsilon=epsilon==null?1e-8:epsilon;var matrix=portalMatrix(portal),inverse=matInvertRigid(matrix),a=transformPoint(inverse,from),b=transformPoint(inverse,to),dz=b[2]-a[2];if(Math.abs(dz)<=epsilon)return null;var t=-a[2]/dz;if(t<=epsilon||t>1+epsilon)return null;var local=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,0];if(!apertureContains(portal,local,epsilon*8))return null;return {portal:portal,t:clamp(t,0,1),local:local,point:add(from,scale(sub(to,from),t)),side:dz<0?1:-1};
  }
  function deterministicCrossing(sceneInput,from,to,options){
    options=options||{};var scene=normalizeScene(sceneInput),epsilon=finite(options.epsilon,1e-7),hits=[];
    scene.portals.forEach(function(p,index){if(!p.enabled)return;var hit=portalIntersection(p,from,to,epsilon);if(hit){hit.index=index;hit.priority=p.priority;hits.push(hit);}});
    hits.sort(function(a,b){if(Math.abs(a.t-b.t)>epsilon)return a.t-b.t;if(a.priority!==b.priority)return a.priority-b.priority;return a.portal.id.localeCompare(b.portal.id);});
    if(!hits.length)return null;var first=hits[0],target=scene.portals.find(function(p){return p.id===first.portal.targetId;});if(!target)return null;first.target=target;first.transform=portalTeleport(first.portal,target);first.overlapOwners=hits.filter(function(h){return Math.abs(h.t-first.t)<=epsilon;}).map(function(h){return h.portal.id;});return first;
  }
  function mapPointThrough(source,target,point){return transformPoint(portalTeleport(source,target),point);}
  function mapVectorThrough(source,target,vector){return transformVector(portalTeleport(source,target),vector);}
  function traceMovement(sceneInput,from,delta,options){
    options=options||{};var scene=normalizeScene(sceneInput),maxCrossings=Math.max(0,Math.trunc(finite(options.maxCrossings,64))),epsilon=finite(options.epsilon,1e-6),position=from.slice(),remaining=delta.slice(),events=[];
    for(var step=0;step<maxCrossings;step++){
      var end=add(position,remaining),hit=deterministicCrossing(scene,position,end,{epsilon:epsilon});if(!hit){position=end;remaining=[0,0,0];break;}
      var before=scale(remaining,hit.t),after=scale(remaining,1-hit.t),mappedPoint=mapPointThrough(hit.portal,hit.target,hit.point),mappedAfter=mapVectorThrough(hit.portal,hit.target,after),dir=normalize(mappedAfter);
      position=add(mappedPoint,scale(dir,epsilon));remaining=mappedAfter;events.push({source:hit.portal.id,target:hit.target.id,t:hit.t,owners:hit.overlapOwners.slice(),point:hit.point.slice(),mappedPoint:mappedPoint.slice()});
      if(length(remaining)<=epsilon){remaining=[0,0,0];break;}
    }
    return {position:position,remaining:remaining,events:events,crossings:events.length,truncated:length(remaining)>epsilon};
  }
  function roomIntersection(origin,direction,half,epsilon){
    epsilon=epsilon==null?1e-8:epsilon;var best=Infinity,face=-1;for(var axis=0;axis<3;axis++){var d=direction[axis];if(Math.abs(d)<=epsilon)continue;for(var sign=-1;sign<=1;sign+=2){var t=(sign*half[axis]-origin[axis])/d;if(t>epsilon&&t<best){var p=add(origin,scale(direction,t)),ok=true;for(var j=0;j<3;j++)if(j!==axis&&Math.abs(p[j])>half[j]+epsilon*8)ok=false;if(ok){best=t;face=axis*2+(sign>0?1:0);}}}}return Number.isFinite(best)?{distance:best,face:face,point:add(origin,scale(direction,best))}:null;
  }
  function traceRay(sceneInput,origin,direction,options){
    options=options||{};var scene=normalizeScene(sceneInput),dir=normalize(direction),point=origin.slice(),travel=0,events=[],maxEvents=Math.max(0,Math.trunc(finite(options.maxEvents,128))),epsilon=finite(options.epsilon,1e-6),half=scene.settings.roomSize.slice();
    for(var step=0;step<=maxEvents;step++){
      var wall=roomIntersection(point,dir,half,epsilon),wallEnd=wall?add(point,scale(dir,wall.distance)):add(point,scale(dir,1e6)),hit=deterministicCrossing(scene,point,wallEnd,{epsilon:epsilon});
      if(!hit){return {resolved:!!wall,face:wall?wall.face:-1,point:wall?wall.point:null,travel:travel+(wall?wall.distance:0),events:events,crossings:events.length,truncated:false};}
      var segment=wall?wall.distance*hit.t:length(sub(hit.point,point));travel+=segment;events.push({source:hit.portal.id,target:hit.target.id,travel:travel,owners:hit.overlapOwners.slice()});point=add(mapPointThrough(hit.portal,hit.target,hit.point),scale(normalize(mapVectorThrough(hit.portal,hit.target,dir)),epsilon));dir=normalize(mapVectorThrough(hit.portal,hit.target,dir));
    }
    return {resolved:false,face:-1,point:null,travel:travel,events:events,crossings:events.length,truncated:true};
  }

  function candidateOrder(a,b){var ap=finite(a.priority,0),bp=finite(b.priority,0);if(ap!==bp)return ap-bp;var aa=finite(a.area,0),ba=finite(b.area,0);if(aa!==ba)return ba-aa;return String(a.id||'').localeCompare(String(b.id||''));}
  function fairSchedule(root,expand,options){
    if(typeof expand!=='function')throw new TypeError('expand must be a function');options=options||{};
    var maxCopies=Math.max(1,Math.trunc(finite(options.maxCopies,4097))),maxDepth=Math.max(0,Math.trunc(finite(options.maxDepth,2048))),minArea=Math.max(0,finite(options.minArea,0));
    var queue=[Object.assign({depth:0,rootBranch:null,path:'root'},root||{})],cursor=0,copies=[],terminals=[],branchDepths=Object.create(null),expanded=0;
    while(cursor<queue.length&&copies.length<maxCopies){
      var node=queue[cursor++],depth=Math.max(0,Math.trunc(finite(node.depth,0)));copies.push(node);
      if(node.rootBranch!=null)branchDepths[node.rootBranch]=Math.max(branchDepths[node.rootBranch]||0,depth);
      if(depth>=maxDepth){terminals.push({node:node,reason:'depth'});continue;}
      var candidates=(expand(node)||[]).filter(function(c){return finite(c.area,Infinity)>=minArea;}).slice().sort(candidateOrder);expanded+=candidates.length;
      var pending=queue.length-cursor,available=Math.max(0,maxCopies-copies.length-pending),take=Math.min(available,candidates.length);
      for(var i=0;i<take;i++){var c=candidates[i],branch=node.rootBranch==null?String(c.rootBranch||c.id||i):node.rootBranch;queue.push(Object.assign({},c,{depth:depth+1,rootBranch:branch,path:node.path+'/'+String(c.id||i)}));}
      for(var j=take;j<candidates.length;j++)terminals.push({node:node,candidate:candidates[j],reason:'capacity'});
    }
    while(cursor<queue.length)terminals.push({node:queue[cursor++],reason:'capacity'});
    var depths=Object.values(branchDepths),minDepth=depths.length?Math.min.apply(Math,depths):0,maxDepthSeen=depths.length?Math.max.apply(Math,depths):0;
    return {copies:copies,terminals:terminals,stats:{scheduler:'breadth-fair-v1',maxCopies:maxCopies,maxDepth:maxDepth,copies:copies.length,expanded:expanded,terminalCount:terminals.length,branchDepths:branchDepths,minBranchDepth:minDepth,maxBranchDepth:maxDepthSeen,fairnessSpan:maxDepthSeen-minDepth,conservativeTerminal:true}};
  }

  function attachRuntime(adapter){
    if(!adapter||typeof adapter!=='object')throw new TypeError('runtime adapter object required');
    ['getScene','loadScene','getState','rerender'].forEach(function(name){if(typeof adapter[name]!=='function')throw new TypeError('runtime adapter missing '+name);});
    runtimeAdapter=adapter;return runtime();
  }
  function runtime(){if(!runtimeAdapter)return null;return Object.freeze({
    getScene:function(){return clone(runtimeAdapter.getScene());},loadScene:function(scene){return runtimeAdapter.loadScene(normalizeScene(scene));},getState:function(){return clone(runtimeAdapter.getState());},rerender:function(){return runtimeAdapter.rerender();},
    toggleEdit:runtimeAdapter.toggleEdit?function(){return runtimeAdapter.toggleEdit();}:undefined,
    setEditMode:runtimeAdapter.setEditMode?function(v){return runtimeAdapter.setEditMode(!!v);}:undefined,
    select:runtimeAdapter.select?function(id){return runtimeAdapter.select(String(id));}:undefined,
    addPair:runtimeAdapter.addPair?function(shape){return runtimeAdapter.addPair(shape);}:undefined,
    addCompressed:runtimeAdapter.addCompressed?function(){return runtimeAdapter.addCompressed();}:undefined,
    duplicate:runtimeAdapter.duplicate?function(){return runtimeAdapter.duplicate();}:undefined,
    remove:runtimeAdapter.remove?function(){return runtimeAdapter.remove();}:undefined,
    undo:runtimeAdapter.undo?function(){return runtimeAdapter.undo();}:undefined,
    redo:runtimeAdapter.redo?function(){return runtimeAdapter.redo();}:undefined,
    lifecycle:runtimeAdapter.lifecycle?function(){return clone(runtimeAdapter.lifecycle());}:undefined
  });}

  var SUPPORTED_ENVELOPE=Object.freeze({
    canonicalRenderer:'euclidean-unfolded-raster-breadth-fair-v1',
    exactWithin:'All room copies admitted by the finite portal depth, screen-area predicate, and 4097-copy release budget use ordinary Euclidean rasterization with deterministic aperture ownership.',
    conservativeBeyond:'Branches not admitted by the finite budget remain closed terminal portal surfaces; they are never opened as holes or mislabeled pixel-exact.',
    dag:'The supplied decision-DAG backend exactly constructs finite per-pixel Euclidean state for supported pure-translation rectangular scenes and fails closed on construction errors.',
    compressed:'Compressed-space rendering is an explicitly opt-in bounded metric extension. It is not used by the canonical pure-portal default and is not claimed exact beyond its event limit.',
    infinite:'No finite renderer can certify arbitrary infinite recursive visibility for every topology.'
  });

  return Object.freeze({VERSION:VERSION,SCENE_VERSION:SCENE_VERSION,CORPUS_VERSION:CORPUS_VERSION,SUPPORTED_ENVELOPE:SUPPORTED_ENVELOPE,
    normalizeScene:normalizeScene,validateScene:validateScene,stableStringify:stableStringify,encodeScene:encodeScene,decodeScene:decodeScene,sceneFingerprint:sceneFingerprint,
    portalMatrix:portalMatrix,portalTeleport:portalTeleport,mapPointThrough:mapPointThrough,mapVectorThrough:mapVectorThrough,apertureContains:apertureContains,
    deterministicCrossing:deterministicCrossing,traceMovement:traceMovement,traceRay:traceRay,fairSchedule:fairSchedule,attachRuntime:attachRuntime,runtime:runtime,
    _internals:Object.freeze({matMultiply:matMultiply,matInvertRigid:matInvertRigid,transformPoint:transformPoint,transformVector:transformVector,portalIntersection:portalIntersection,roomIntersection:roomIntersection,fnv1a64:fnv1a64})});
});
