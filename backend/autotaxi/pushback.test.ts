import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPushback } from './pushback-route.js';
import { createPushbackSession } from './pushback-session.js';
import { createPushbackPreviews } from './pushback-preview.js';
import { angle, distance, type Point } from './route.js';
import type { TaxiAirport } from './session.js';
import type { PushbackCommand } from './pushback-session.js';
import { createAircraftPushback, tugHeading, writeSimulatorTug } from '../telemetry-provider/aircraft-pushback.js';
import { createAutotaxi } from '../telemetry-provider/aircraft-autotaxi.js';

const dim = { wheelbaseM: 15, lengthM: 40 };
function airport(east = true, rotation = 0): TaxiAirport {
  const turn = (p: Point) => ({ x: p.x * Math.cos(rotation * Math.PI / 180) + p.z * Math.sin(rotation * Math.PI / 180),
    z: -p.x * Math.sin(rotation * Math.PI / 180) + p.z * Math.cos(rotation * Math.PI / 180) });
  const coords = [[-200,-60], [200,-60], [-1000,-60], [1000,-60], [-1000,-340], [1000,-340], [-1200,-400], [1200,-400]];
  const points = coords.map(([x,z], id) => ({ id, type: id === 4 || id === 5 ? 2 : 1, orientation: 0, ...turn({ x,z }) }));
  const paths = [[0,1], [0,2], [1,3], [2,4], [3,5], [4,6], [5,7], [6,7]].map(([start,end], id) => ({ id,start,end,type: id === 7 ? 2 : 1,widthM: 25,runway: id === 7 ? '09' : null }));
  const threshold = points[east ? 7 : 6];
  return { origin: {lat:0,lon:0}, graph: {complete:true,points,paths},
    threshold: {lat:threshold.z / 6371000 * 180 / Math.PI,lon:threshold.x / 6371000 * 180 / Math.PI}, reciprocal: east ? '27' : '09' };
}

test('pushback chooses the onward taxi direction for the requested departure end', () => {
  for (const rotate of [0, 37, 179, 270]) for (const east of [true, false]) {
    let plan!: ReturnType<typeof planPushback>;
    assert.doesNotThrow(() => { plan = planPushback(airport(east, rotate), { x:0,z:0 }, rotate, east ? '09' : '27', dim); }, `rotation ${rotate}, east ${east}`);
    assert.ok(Math.abs(angle(plan.headingDeg - rotate - (east ? 90 : 270))) < 0.01);
    assert.ok(plan.lengthM > 40 && plan.lengthM < 180);
    assert.ok(Math.abs(angle(plan.points[0].headingDeg - rotate)) < 0.01);
    assert.ok(distance(plan.points.at(-1)!, plan.taxiRoute.points[0]) < 0.01);
    assert.ok(plan.taxiRoute.lengthM > 1000);
    assert.ok(plan.points.every(p => p.distanceM >= 0));
  }
});

test('missing, distant and runway-crossing pushback geometry never produces a guessed direction', () => {
  const incomplete = airport(); incomplete.graph.complete = false;
  assert.throws(() => planPushback(incomplete, { x:0,z:0 },0,'09',dim), /Complete/);
  assert.throws(() => planPushback(airport(), { x:0,z:1000 },0,'09',dim), /No simple/);
  const crossing = airport();
  crossing.graph.points.push({id:8,type:1,orientation:0,x:-200,z:-30},{id:9,type:1,orientation:0,x:200,z:-30});
  crossing.graph.paths.push({id:8,type:2,start:8,end:9,widthM:40,runway:'18'});
  assert.throws(() => planPushback(crossing,{x:0,z:0},0,'09',dim), /No simple/);
});

function fixture() {
  let now = 10000, live = true, conflict = false, revision = 1, pose = { x:0,z:0,headingDeg:0,speedKts:0 }, parked = false;
  const identity = {}, owner = {}, writes: {heading: number|null; speed:number}[] = [];
  let tugState = 3;
  const deps = { now: () => now, dimensions: () => dim, airport: async () => airport(), conflict: () => conflict,
    capture: () => ({...pose,lat:pose.z/6371000*180/Math.PI,lon:pose.x/6371000*180/Math.PI,
      timeMs:now,ready:true,guidanceReady:live,guidanceReason:'No fresh ground position.',profileKey:'fixture',profileRevision:revision,generation:identity,parked,
      tug: {state:tugState,forwardSpeedFps: -pose.speedKts / 0.592484}}),
    write: async (command: PushbackCommand, valid:()=>boolean) => {
      assert.equal(valid(),true);
      writes.push({heading:command.kind === 'steer' ? command.headingDeg : pose.headingDeg,speed:command.kind === 'stop' ? 0 : -4.55});
      if(command.kind==='stop') {pose.speedKts=0;tugState=3;}
      if(command.kind==='start') tugState=0;
    } };
  const session = createPushbackSession(deps);
  const request = { operation:'start',icao:'TEST',runway:'09',profileKey:'fixture',profileRevision:1 };
  return { session,deps,owner,writes,request, step: (p?: Partial<typeof pose>, ms=250) => {now+=ms; if(p) pose={...pose,...p};},
    stale:()=>{live=false;}, changeAircraft:()=>{revision++;}, brake:()=>{parked=true;}, conflict:()=>{conflict=true;} };
}

test('heading-servo pushback finishes aligned in both directions across slow responses and rotated scenery', async () => {
  // Finite heading response and command latency reproduce the live PMDG
  // failure hidden by the previous fixture's instantaneous heading changes.
  for (const response of [0.07, 0.1, 0.2]) for (const east of [true, false]) for (const rotation of [0, 37, 179, 270]) {
    const f = fixture();
    f.deps.airport = async () => airport(east, rotation);
    let pose = { x: 0, z: 0, headingDeg: rotation, speedKts: 0 };
    let yawRate = 0, speed = 0;
    const queue: {heading:number|null;speed:number}[] = [];
    f.step(pose);
    try {
      await f.session.request({ ...f.request, runway: east ? '09' : '27' }, f.owner);
      for (let i = 0; i < 600 && f.session.isActive(); i++) {
        queue.push(f.writes.at(-1)!);
        const command = queue.length > 2 ? queue.shift()! : {heading:rotation,speed:0};
        const stopped=f.writes.at(-1)!.speed===0;
        const targetRate=stopped?0:Math.max(-8,Math.min(8,response*angle((command.heading??pose.headingDeg)-pose.headingDeg)));
        yawRate+=(targetRate-yawRate)*0.5;
        const heading=(pose.headingDeg+yawRate*0.25+360)%360;
        speed=stopped?Math.max(0,speed-0.22*0.25):Math.min(1.39,speed+0.5);
        const metres = -speed * 0.25;
        pose = { x: pose.x + Math.sin(heading * Math.PI / 180) * metres,
          z: pose.z + Math.cos(heading * Math.PI / 180) * metres, headingDeg: heading,
          speedKts: speed / 0.514444 };
        f.step(pose);
        await f.session.request({ operation: 'status' }, f.owner);
        await f.session.tick();
      }
      assert.equal(f.session.state().status, 'complete', JSON.stringify({ response, east, rotation, pose, state: f.session.state() }));
      assert.ok(Math.abs(angle(pose.headingDeg - rotation - (east ? 90 : 270))) <= 12);
    } finally { await f.session.dispose(); }
  }
});

test('pushback preview is read-only, available with parking brake, and bound to its viewer and exact destination', async () => {
  const f = fixture(), previews = createPushbackPreviews(f.deps);
  try {
    f.brake();
    const message = { ...f.request, operation: 'preview' };
    const result = await previews.request(message, f.owner, () => true);
    const start = { ...f.request, previewId: result.pushbackPreview!.id };
    assert.equal(f.writes.length, 0);
    assert.ok(result.pushbackPreview!.points!.length > 2);
    assert.ok(distance(result.preview!.points[0], result.pushbackPreview!.points!.at(-1)!) < 0.001);
    const prepared = previews.prepared(start, f.owner);
    assert.deepEqual(prepared.plan.points, result.pushbackPreview!.points);
    assert.throws(() => previews.prepared(start, {}), /preview changed/);
    assert.throws(() => previews.prepared({ ...start, runway: '27' }, f.owner), /preview changed/);
    f.step({ x: 3 });
    assert.equal((await previews.request({ ...message, operation: 'status' }, f.owner, () => true)).pushbackPreview!.valid, false);
    assert.throws(() => previews.prepared(start, f.owner), /preview changed/);
    assert.equal(f.writes.length, 0);
  } finally { await f.session.dispose(); }
});

test('starting the shown plan does not reload scenery; read-only progress cannot keep pushback moving', async () => {
  const f = fixture(), previews = createPushbackPreviews(f.deps);
  try {
    const result = await previews.request({ ...f.request, operation: 'preview' }, f.owner, () => true);
    const start = { ...f.request, previewId: result.pushbackPreview!.id };
    const prepared = previews.prepared(start, f.owner);
    f.deps.airport = async () => { throw new Error('Must use the shown plan'); };
    await f.session.request(start, f.owner, () => true, prepared);
    f.step(undefined, 3100);
    const before = f.writes.length;
    assert.equal(previews.view(prepared, true, 'pushing').pushbackPreview!.id, start.previewId);
    assert.equal(f.writes.length, before);
    await f.session.tick();
    assert.equal(f.writes.at(-1)!.speed, 0);
    f.step({ speedKts: 0 }); await f.session.tick();
    assert.equal(f.session.isActive(), false);
  } finally { await f.session.dispose(); }
});

test('preview expires on aircraft change, age and cancelled scenery loads', async () => {
  for (const change of ['aircraft', 'age', 'position']) {
    const f = fixture(), previews = createPushbackPreviews(f.deps);
    try {
      const result = await previews.request({ ...f.request, operation: 'preview' }, f.owner, () => true);
      if (change === 'aircraft') f.changeAircraft();
      else if (change === 'age') f.step(undefined, 61000);
      else f.step({ headingDeg: 10 });
      assert.throws(() => previews.prepared({ ...f.request, previewId: result.pushbackPreview!.id }, f.owner), /preview changed/);
    } finally { await f.session.dispose(); }
  }
  const f = fixture(); let finish!: (a: TaxiAirport) => void, connected = true;
  f.deps.airport = () => new Promise(resolve => { finish = resolve; });
  const previews = createPushbackPreviews(f.deps);
  const result = previews.request({ ...f.request, operation: 'preview' }, f.owner, () => connected);
  connected = false; finish(airport());
  await assert.rejects(result, /moved or changed/);
  assert.equal(f.writes.length, 0); await f.session.dispose();
});

test('one click pushes to the route, confirms stopped, then hands back without aircraft-axis writes', async () => {
  const f=fixture();
  try {
    await f.session.request(f.request,f.owner);
    assert.equal(f.session.state().status,'connecting');
    await assert.rejects(f.session.request(f.request,f.owner),/already/);
    const plan=planPushback(airport(),{x:0,z:0},0,'09',dim);
    for(const p of plan.points) {
      f.step({...p,speedKts:2}); await f.session.request({operation:'status'},f.owner); await f.session.tick();
    }
    f.step({speedKts:0}); await f.session.tick();
    assert.equal(f.session.state().status,'complete');
    assert.equal(f.session.isActive(),false);
    assert.equal(f.writes.at(-1)?.speed,0);
    assert.ok(f.writes.some(w=>w.heading!==null && w.heading>45));
    assert.ok(f.writes.every(w=>w.speed===-4.55 || w.speed===0));
  } finally {await f.session.dispose();}
});

test('stop, stale telemetry, parking brake, lost owner, overspeed and excessive deviation all stop pushback', async () => {
  for(const change of ['stop','stale','brake','lease','speed','deviation','conflict']) {
    const f=fixture();
    try {
      await f.session.request(f.request,f.owner);
      if(change==='stop') await f.session.request({operation:'stop'},f.owner);
      if(change==='stale') f.stale();
      if(change==='brake') f.brake();
      if(change==='lease') {f.step(undefined,3100);await f.session.request({operation:'status'},{});}
      if(change==='speed') f.step({speedKts:6});
      if(change==='deviation') f.step({x:20});
      if(change==='conflict') f.conflict();
      await f.session.tick();
      assert.equal(f.writes.at(-1)?.speed,0,change);
      const count=f.writes.length; f.step(); await f.session.tick();
      assert.equal(f.writes.length,count,change+' never restarts');
    } finally {await f.session.dispose();}
  }
});

test('aircraft changes and cancelled scenery loads cannot write to a replacement aircraft', async () => {
  const f=fixture(); let resolve: (a:TaxiAirport)=>void = ()=>{};
  f.deps.airport=()=>new Promise(r=>{resolve=r;});
  const request=f.session.request(f.request,f.owner);
  await f.session.request({operation:'stop'},f.owner); resolve(airport());
  await assert.rejects(request,/cancelled/); assert.equal(f.writes.length,0);
  const g=fixture();
  try {
    await g.session.request(g.request,g.owner); const count=g.writes.length;
    g.changeAircraft(); await g.session.tick();
    assert.equal(g.writes.length,count); assert.equal(g.session.isActive(),false);
  } finally {await f.session.dispose();await g.session.dispose();}
});

test('pushback readiness and exact unsigned heading values are independent of autothrottle/engine control', async () => {
  assert.equal(tugHeading(0),0); assert.equal(tugHeading(90),1073741824);
  assert.equal(tugHeading(180),2147483648); assert.equal(tugHeading(270),3221225471);
  assert.equal(tugHeading(360),0); assert.throws(()=>tugHeading(NaN));
  const f=fixture(); f.brake();
  await assert.rejects(f.session.request(f.request,f.owner),/parking brake/); assert.equal(f.writes.length,0);
  await f.session.dispose();
});

test('tug dimensions do not require an Autotaxi adapter or engine telemetry', () => {
  const context = createAutotaxi({ _lastDetectedAircraftTitle: 'aircraft.cfg' }, { getActiveProfileId: () => 'unsupported' }, Date.now,
    { readOnly: true, resolveModel: () => ({ ok: true, ...dim, maxSteeringDeg: 60, wheelTrackM: 8, noseOffsetM: 12,
      identity: 'test', fingerprint: 'test', sourceFiles: [] }) }).groundContext;
  assert.deepEqual(context.dimensions(), dim);
});

test('a failed motion command sends an idempotent stop, and a failed stop remains a fault', async () => {
  for (const stopFails of [false, true]) {
    const f = fixture();
    f.deps.write = async command => {
      const heading = command.kind === 'steer' ? command.headingDeg : null, speed = command.kind === 'stop' ? 0 : -4.55;
      f.writes.push({ heading, speed });
      if (speed !== 0 || stopFails) throw new Error('Simulator command failed.');
    };
    try {
      await f.session.request(f.request, f.owner);
      assert.deepEqual(f.writes.map(w => w.speed), [-4.55, 0]);
      await f.session.tick();
      assert.equal(f.session.state().status, stopFails ? 'fault' : 'stopped');
      assert.equal(f.session.isActive(), false);
    } finally { await f.session.dispose(); }
  }
});

test('Stop invalidates an in-flight write before waiting for its completion', async () => {
  const f = fixture(); let resume!: () => void;
  f.deps.write = async (command, valid) => {
    const heading = command.kind === 'steer' ? command.headingDeg : null, speed = command.kind === 'stop' ? 0 : -4.55;
    if (speed !== 0) {
      await new Promise<void>(resolve => { resume = resolve; });
      if (!valid()) throw new Error('Cancelled');
    }
    f.writes.push({ heading, speed });
  };
  try {
    const start = f.session.request(f.request, f.owner);
    await Promise.resolve();
    const stop = f.session.request({ operation: 'stop' }, f.owner);
    resume(); await Promise.all([start, stop]);
    assert.ok(f.writes.length > 0); assert.ok(f.writes.every(w => w.speed === 0));
    await f.session.tick(); assert.equal(f.session.isActive(), false);
  } finally { await f.session.dispose(); }
});

test('delayed tug writes recheck ground data, brake, conflict, speed and pose at the transport boundary', async () => {
  for (const change of ['stale', 'brake', 'conflict', 'speed', 'position', 'heading', 'age']) {
    const f = fixture(); let resume!: () => void;
    f.deps.write = async (command, valid) => {
      const heading = command.kind === 'steer' ? command.headingDeg : null, speed = command.kind === 'stop' ? 0 : -4.55;
      if (speed !== 0) {
        await new Promise<void>(resolve => { resume = resolve; });
        if (!valid()) throw new Error('Expired motion');
      }
      f.writes.push({ heading, speed });
    };
    try {
      const start = f.session.request(f.request, f.owner); await Promise.resolve();
      if (change === 'stale') f.stale();
      if (change === 'brake') f.brake();
      if (change === 'conflict') f.conflict();
      if (change === 'speed') f.step({ speedKts: 6 });
      if (change === 'position') f.step({ x: 15 });
      if (change === 'heading') f.step({ headingDeg: 90 });
      if (change === 'age') f.step(undefined, 1100);
      resume(); await start;
      assert.ok(f.writes.length > 0 && f.writes.every(w => w.speed === 0), change + ' cannot dispatch delayed motion');
    } finally { await f.session.dispose(); }
  }
});

test('repeated Stop requests cannot postpone stopped-confirmation timeout', async () => {
  const f = fixture();
  try {
    await f.session.request(f.request, f.owner); f.stale();
    await f.session.request({ operation: 'stop' }, f.owner);
    for (let i = 0; i < 17; i++) {
      f.step(undefined, 1000); await f.session.request({ operation: 'stop' }, f.owner); await f.session.tick();
    }
    assert.equal(f.session.state().status, 'fault');
    assert.equal(f.writes.filter(w => w.speed === 0).length, 1, 'Stop remains idempotent while waiting for readback');
  } finally { await f.session.dispose(); }
});

test('a newly opened viewer receives completed pushback and onward guidance while the aircraft taxis', async () => {
  const f = fixture(), groundModule = require('../telemetry-provider/aircraft-autotaxi.js');
  const original = groundModule.createAutotaxi;
  let loads = 0;
  let tugState = 3;
  groundModule.createAutotaxi = () => ({ groundContext: { ...f.deps, parked: () => false, tug: () => ({state:tugState,forwardSpeedFps:-f.deps.capture().speedKts/0.592484}),
    airport: async () => { loads++; return airport(); } } });
  const session = createAircraftPushback({ _lvarBridge: { startPushback: async () => { tugState=0; return {ok:true}; }, sendEvent: async (name) => {
    if (name === 'TUG_DISABLE') {f.step({ speedKts: 0 });tugState=3;}
    return { ok: true };
  } } }, {}, f.deps.now);
  groundModule.createAutotaxi = original;
  try {
    const message = { ...f.request, operation: 'preview' };
    const preview = await session.preview(message, f.owner, () => true);
    await session.request({ ...f.request, previewId: preview.pushbackPreview!.id }, f.owner, () => true);
    const plan = planPushback(airport(), { x: 0, z: 0 }, 0, '09', dim);
    for (const p of plan.points) { f.step({ ...p, speedKts: 2 }); await session.request({ operation: 'status' }, f.owner, () => true); await session.tick(); }
    f.step({ speedKts: 0 }); await session.tick(); assert.equal(session.state().status, 'complete');
    f.step({ speedKts: 3 });
    const reopened = await session.preview(message, {}, () => true);
    assert.equal(reopened.pushbackPreview!.phase, 'complete');
    assert.equal(reopened.pushbackPreview!.id, preview.pushbackPreview!.id);
    assert.deepEqual(reopened.preview, preview.preview); assert.equal(loads, 1);
    f.changeAircraft(); await assert.rejects(async () => session.preview(message, {}, () => true), /Stop on the ground|Aircraft changed/);
  } finally { groundModule.createAutotaxi = original; await session.dispose(); await f.session.dispose(); }
});

test('simulator transport starts exactly once, steers without speed writes and guards activation after disable', async () => {
  const commands: [string, number][] = [];
  let valid = true, invalidateDisable = false;
  const bridge = { async startPushback() { commands.push(['TOGGLE_PUSHBACK',0]); return {ok:true}; }, async sendEvent(name: string, value: number) {
    commands.push([name, value]);
    if (name === 'TUG_DISABLE' && invalidateDisable) valid = false;
    return { ok:true };
  } };
  await writeSimulatorTug(bridge, {kind:'start'}, () => valid);
  await writeSimulatorTug(bridge, {kind:'steer',headingDeg:270}, () => valid);
  assert.deepEqual(commands.splice(0), [['TUG_DISABLE',0],['TOGGLE_PUSHBACK',0],['TUG_HEADING',3221225471]]);
  invalidateDisable = true;
  await assert.rejects(writeSimulatorTug(bridge, {kind:'start'}, () => valid), /ownership/);
  assert.deepEqual(commands.splice(0), [['TUG_DISABLE',0]]);
  valid = true;
  await writeSimulatorTug(bridge, {kind:'stop'}, () => valid);
  assert.deepEqual(commands, [['TUG_DISABLE',0]]);
});

test('coupling may take 45 seconds, starts once, and pushing means observed reverse movement', async () => {
  const f = fixture(), commands: PushbackCommand[] = [], write = f.deps.write;
  f.deps.write = async (command, valid) => { commands.push(command); await write(command, valid); };
  try {
    await f.session.request(f.request, f.owner);
    for (let i = 0; i < 180; i++) {
      f.step(); await f.session.request({operation:'status'}, f.owner); await f.session.tick();
      assert.equal(f.session.state().status,'connecting');
    }
    assert.equal(commands.filter(c=>c.kind==='start').length,1);
    f.step({speedKts:2.7,z:-0.5}); await f.session.tick();
    assert.equal(f.session.state().status,'pushing');
    await f.session.request({operation:'stop'},f.owner); await f.session.tick();
    assert.equal(f.session.state().status,'stopped');
  } finally {await f.session.dispose();}
});

test('Stop during coupling, coupling timeout and stale tug state never restart or retoggle', async () => {
  for(const trigger of ['stop','timeout','readback']) {
    const f=fixture(),commands:PushbackCommand[]=[],write=f.deps.write;
    f.deps.write=async(command,valid)=>{commands.push(command);await write(command,valid);};
    try {
      await f.session.request(f.request,f.owner);
      if(trigger==='stop') await f.session.request({operation:'stop'},f.owner);
      else if(trigger==='readback') {
        const capture=f.deps.capture;
        f.deps.capture=()=>({...capture(),tug:null as any});
        f.step();await f.session.tick();
      } else for(let i=0;i<245;i++) {
        f.step();await f.session.request({operation:'status'},f.owner);await f.session.tick();
      }
      assert.equal(commands.filter(c=>c.kind==='start').length,1,trigger);
      assert.equal(commands.at(-1)?.kind,'stop',trigger);
      const count=commands.length;
      f.step(undefined,16000);await f.session.tick();
      assert.equal(commands.length,count,trigger+' does not resume');
    } finally {await f.session.dispose();}
  }
});

test('an existing tug or missing tug readback cannot be toggled into another pushback', async () => {
  for(const tug of [null,{state:0,forwardSpeedFps:0}]) {
    const f=fixture(),capture=f.deps.capture;
    f.deps.capture=()=>({...capture(),tug:tug as any});
    await assert.rejects(f.session.request(f.request,f.owner),/tug readback|current simulator pushback/);
    assert.equal(f.writes.length,0);await f.session.dispose();
  }
});

test('stop confirmation waits through coasting and requires the simulator tug to be off', async () => {
  const f=fixture(),write=f.deps.write,capture=f.deps.capture;
  let tugState=0;
  try {
    await f.session.request(f.request,f.owner);f.step({speedKts:2.7});await f.session.tick();
    f.deps.write=async(command,valid)=>{if(command.kind!=='stop')await write(command,valid);};
    f.deps.capture=()=>({...capture(),tug:{state:tugState,forwardSpeedFps:-capture().speedKts/0.592484}});
    await f.session.request({operation:'stop'},f.owner);
    f.step(undefined,7000);await f.session.tick();assert.equal(f.session.state().status,'stopping');
    f.step({speedKts:0});await f.session.tick();assert.equal(f.session.state().status,'stopping','stationary attached tug is not a confirmed stop');
    tugState=3;f.step();await f.session.tick();assert.equal(f.session.state().status,'stopped');
  } finally {await f.session.dispose();}
});

test('a late SimConnect mapping exception stops pushback despite a successful transport ACK', async () => {
  const f=fixture(), groundModule=require('../telemetry-provider/aircraft-autotaxi.js'), original=groundModule.createAutotaxi;
  let tugState=3, rejected=false;
  const commands:string[]=[];
  groundModule.createAutotaxi=()=>({groundContext:{...f.deps,parked:()=>false,
    tug:()=>({state:tugState,forwardSpeedFps:0})}});
  const session=createAircraftPushback({_lvarBridge:{
    startPushback:async()=>{commands.push('start');tugState=0;return {ok:true,sendIds:[41,42]};},
    sendEvent:async(name:string)=>{commands.push(name);if(name==='TUG_DISABLE')tugState=3;return {ok:true};},
    findRecentSimConnectException:(ids:number[])=>rejected&&ids.includes(41)?{exception:7,sendId:41}:null,
  }},{},f.deps.now);
  groundModule.createAutotaxi=original;
  try {
    const preview=await session.preview({...f.request,operation:'preview'},f.owner,()=>true);
    await session.request({...f.request,previewId:preview.pushbackPreview!.id},f.owner,()=>true);
    rejected=true;f.step();await session.tick();
    assert.match(session.state().error!,/simulator rejected/);
    assert.deepEqual(commands,['TUG_DISABLE','start','TUG_DISABLE']);
    f.step();await session.tick();assert.equal(session.state().status,'stopped');
  } finally {groundModule.createAutotaxi=original;await session.dispose();await f.session.dispose();}
});
