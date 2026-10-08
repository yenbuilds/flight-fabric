'use strict';

const { launchHelperSession } = require('./voice-push-to-talk-hook');
const { normalizeControllerBinding, sameControllerButton, controllerDisplayName } = require('./voice-controller-button');

function createControllerSetup({ helperPath, onChange = () => {}, spawnProcess }) {
  let session = null, timer = null, revision = 0, candidate = null, released = false;
  let info = { phase: 'idle', held: false, selection: null, message: '' };
  const devices = new Map();
  const getInfo = () => ({ ...info });
  function publish(patch) { info = { ...info, ...patch }; onChange(getInfo()); }
  function stopProcess() { clearTimeout(timer); timer = null; session?.stop(); session = null; }
  function fail(message) {
    stopProcess(); candidate = null; released = false;
    publish({ phase: 'error', held: false, selection: null, message });
  }
  function timeout() {
    stopProcess();
    if (released && candidate && !info.held) publish({ phase: 'ready', message: 'Button checked. Save it or choose another button.' });
    else { candidate = null; publish({ phase: 'expired', held: false, selection: null, message: 'No complete press and release was detected. Try again.' }); }
  }
  function handle(event) {
    if (event.type === 'device' && typeof event.path === 'string') {
      if (event.connected === true) {
        const vendor = /^[0-9a-f]{4}$/i.test(event.vendorId) ? event.vendorId.toUpperCase() : 'Unknown';
        const product = /^[0-9a-f]{4}$/i.test(event.productId) ? event.productId.toUpperCase() : 'Unknown';
        devices.set(event.path.toLowerCase(), controllerDisplayName(event.name) || `Controller ${vendor}:${product}`);
      } else {
        devices.delete(event.path.toLowerCase());
        if (candidate?.devicePath.toLowerCase() === event.path.toLowerCase()) fail('The selected controller disconnected. Reconnect it and try again.');
      }
    } else if (event.type === 'baseline' && !candidate && event.heldButtons > 0) {
      publish({ message: 'Release the button, then press and release it again.' });
    } else if (event.type === 'press') {
      if (!candidate && devices.has(event.path?.toLowerCase())) {
        try {
          candidate = normalizeControllerBinding({ version: 1, devicePath: event.path,
            reportId: event.reportId, linkCollection: event.linkCollection, button: event.button,
            label: devices.get(event.path.toLowerCase()) });
        } catch { fail('The controller returned an unsupported button. Try another button.'); return; }
      }
      if (sameControllerButton(event, candidate)) publish({ phase: 'held', held: true,
        selection: { label: candidate.label, button: candidate.button }, message: 'Button pressed. Release it to finish the check.' });
    } else if (event.type === 'release' && sameControllerButton(event, candidate) && info.held) {
      released = true;
      publish({ phase: 'ready', held: false, message: 'Button released. You can hold it again to test, or save it.' });
    } else if (event.type === 'cancel' && event.reason !== 'timeout') {
      if (event.path && event.path.toLowerCase() !== candidate?.devicePath.toLowerCase()) return;
      fail('Button setup was interrupted. Reconnect or unlock this PC, then try again.');
    } else if (event.type === 'stopped') {
      if (event.reason === 'timeout') timeout();
      else fail('Button setup stopped. Try again.');
    } else if (event.type === 'device-error') {
      if (event.scope === 'device') devices.delete(event.path.toLowerCase());
      if (candidate && event.scope !== 'discovery'
        && (event.scope === undefined || event.path.toLowerCase() === candidate.devicePath.toLowerCase())) {
        fail('The selected controller could not be read. Reconnect it and try again.');
      } else if (!candidate) {
        publish({ message: 'A controller could not be read. Try another controller or reconnect it.' });
      }
    }
  }
  function stop() {
    revision++; stopProcess(); devices.clear(); candidate = null; released = false;
    publish({ phase: 'idle', held: false, selection: null, message: '' });
  }
  async function start() {
    stop(); const request = revision;
    publish({ phase: 'listening', message: 'Press and release the button you want to use. Listening for 30 seconds.' });
    try {
      const next = await launchHelperSession({ helperPath, args: ['--controller-setup', '--seconds', '30'], spawnProcess,
        onSpawn: value => { session = value; },
        onEvent: event => { if (request === revision) handle(event); },
        onStopped: () => { if (request === revision) fail('Button setup stopped. Try again.'); } });
      if (request !== revision) { next.stop(); return getInfo(); }
      session = next; next.activate();
      if (session === next) { timer = setTimeout(timeout, 32000); timer.unref?.(); }
    } catch {
      if (request === revision) fail('Button setup could not start. Check the development helper build.');
    }
    return getInfo();
  }
  function bindingToSave() {
    if (!candidate || !released || info.phase !== 'ready' || info.held) throw new Error('Press and release a controller button before saving.');
    return candidate;
  }
  return { start, stop, getInfo, bindingToSave };
}

module.exports = { createControllerSetup };
