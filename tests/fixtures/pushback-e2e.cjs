'use strict';
// Loopback-only browser fixture. Real planning, preview ownership, controller,
// tug event encoding and taxi guidance; only scenery, telemetry and tug physics
// are simulated. It never creates a simulator connection.
module.exports = function createPushbackE2E(runtime, catalogue) {
  const { createTaxiSession } = require(runtime('autotaxi/session.js'));
  const groundModule = require(runtime('telemetry-provider/aircraft-autotaxi.js'));
  const { createAircraftPushback } = require(runtime('telemetry-provider/aircraft-pushback.js'));
  const metresToDegrees = 180 / (6371000 * Math.PI);
  const points = [[-200,-60],[200,-60],[-1000,-60],[1000,-60],[-1000,-340],[1000,-340],[-1200,-400],[1200,-400]]
    .map(([x,z], id) => ({ id, x, z, type: id === 4 || id === 5 ? 2 : 1, orientation: 0 }));
  const paths = [[0,1],[0,2],[1,3],[2,4],[3,5],[4,6],[5,7],[6,7]]
    .map(([start,end], id) => ({ id, start, end, type: id === 7 ? 2 : 1, widthM: 25, runway: id === 7 ? '09' : null }));
  const airport = async () => ({ origin: { lat: 0, lon: 0 }, graph: { complete: true, points, paths },
    threshold: { lat: points[7].z * metresToDegrees, lon: points[7].x * metresToDegrees }, reciprocal: '27' });
  const pose = { x: 0, z: 0, headingDeg: 0, speedKts: 0 }, generation = {}, owner = {}, observer = {};
  let parked = true, speedFps = 0, shownId = null, tugState = 3, couplingAt = 0;
  let targetHeading=0,yawRate=0;
  const writes = [], requests = [];
  const capture = () => ({ ...pose, lat: pose.z * metresToDegrees, lon: pose.x * metresToDegrees,
    timeMs: Date.now(), guidanceReady: true, ready: false, reason: 'Manual guidance only.',
    profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision, generation });
  const ground = { capture, airport, dimensions: () => ({ wheelbaseM: 15, lengthM: 40 }), parked: () => parked,
    tug: () => ({state:tugState,forwardSpeedFps:speedFps}) };
  const provider = { _lvarBridge: { async startPushback() {
    if(tugState!==3) throw new Error('Tug already active');
    tugState=0;couplingAt=Date.now()+1500;writes.push({name:'TOGGLE_PUSHBACK',value:0});return {ok:true};
  }, async sendEvent(name, value) {
    writes.push({ name, value });
    if (name === 'TUG_HEADING') targetHeading = value / 0xffffffff * 360;
    if (name === 'TUG_SPEED') throw new Error('Pushback must use normal simulator speed');
    if (name === 'TUG_DISABLE') {tugState=3;couplingAt=0;}
    pose.speedKts = Math.abs(speedFps) * 0.592484;
    return { ok: true };
  } } };
  const original = groundModule.createAutotaxi;
  let pushback;
  try {
    groundModule.createAutotaxi = () => ({ groundContext: ground });
    pushback = createAircraftPushback(provider, {});
  } finally { groundModule.createAutotaxi = original; }
  const taxi = createTaxiSession({ now: Date.now, capture, airport, handling: () => null,
    parked: () => parked, write: async () => { throw new Error('Manual guidance must not write controls.'); } });
  // Accelerated tug: each real 50 ms advances 300 ms of simulated motion.
  // Heading has a finite response; disable coasts to a stop. The earlier
  // instantaneous-heading model concealed the PMDG's turn-tracking failure.
  const plant = setInterval(() => {
    if(tugState!==3 && Date.now()>=couplingAt) speedFps=-4.55;
    if(tugState===3) speedFps=Math.min(0,speedFps+0.22*0.3/0.3048);
    const error=((targetHeading-pose.headingDeg+540)%360+360)%360-180;
    const targetRate=tugState!==3&&speedFps<0?Math.max(-8,Math.min(8,error*0.1)):0;
    yawRate+=(targetRate-yawRate)*0.5;pose.headingDeg=(pose.headingDeg+yawRate*.3+360)%360;
    pose.speedKts=Math.abs(speedFps)*0.592484;
    const distance = speedFps * 0.3048 * 0.3;
    pose.x += Math.sin(pose.headingDeg * Math.PI / 180) * distance;
    pose.z += Math.cos(pose.headingDeg * Math.PI / 180) * distance;
  }, 50);
  const context = () => ({ currentProfileKey: catalogue.profileKey, currentProfileRevision: catalogue.profileRevision });
  async function request(message) {
    if (message.fixture === 'brake') { parked = message.parked; return { ok: true }; }
    // Independent observer mirrors the toolbar's read-only viewer identity.
    if (message.fixture === 'observer') return pushback.preview({ operation: 'preview', icao: 'TEST', runway: '09',
      profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision }, observer, () => true);
    requests.push(message);
    const type = message.type === 'pushback' ? 'pushbackState' : message.type === 'autotaxi' ? 'autotaxiState' : 'toolbarTaxiState';
    try {
      let result;
      if (message.type === 'pushback') result = await pushback.request(message, owner, () => true);
      else if (message.type === 'requestTaxiGuidance' && message.pushback) {
        result = await pushback.preview(message, owner, () => true);
        if (result.pushbackPreview?.valid) shownId = result.pushbackPreview.id;
      } else if (message.type === 'autotaxi' && ['status', 'preview', 'parkings', 'stop'].includes(message.operation)) {
        result = await taxi.request(message, owner, () => true);
      } else throw new Error('Unexpected control request in manual departure journey.');
      return { ...result, ...context(), type, requestId: message.requestId, ok: true };
    } catch (error) { return { ...context(), type, requestId: message.requestId, ok: false, error: error.message }; }
  }
  return {
    async middleware(req, res) {
      res.setHeader('Content-Type', 'application/json');
      try {
        let result;
        if (req.method === 'GET') result = { state: pushback.state(), pose, writes, requests, shownId };
        else { let body = ''; for await (const chunk of req) body += chunk; result = await request(JSON.parse(body)); }
        res.end(JSON.stringify(result));
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
    },
    async dispose() { clearInterval(plant); await pushback.dispose(); await taxi.dispose(); },
  };
};
