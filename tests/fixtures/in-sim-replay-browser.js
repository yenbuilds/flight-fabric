import './logbook-workspace-browser.js';
import { createApp } from 'vue';
import { getActivePinia } from 'pinia';
import InSimReplayPanel from '../../frontend/src/vue/components/InSimReplayPanel.vue';
import { setAppServices } from '../../frontend/app-shared.js';
import { emitWsMessage, emitWsOpen, emitWsClose } from '../../frontend/src/app/runtime-signals.js';

const bootstrap = await (await fetch('/api/toolbar/bootstrap')).json();
let socket;
setAppServices({ getWs: () => socket, getAuthorizationScope: () => 'full-control',
  sendWs: message => { if (socket?.readyState !== 1) return false; socket.send(JSON.stringify(message)); return true; } });
const host = document.createElement('div');
document.body.insertBefore(host, document.getElementById('app'));
createApp(InSimReplayPanel).use(getActivePinia()).mount(host);
function connect() {
  socket = new WebSocket(`ws://127.0.0.1:${bootstrap.wsPort}/?client=desktop`);
  socket.onmessage = event => emitWsMessage(JSON.parse(event.data));
  socket.onopen = () => emitWsOpen();
  socket.onclose = () => emitWsClose();
}
connect();
window.logbookTest.loadFlight();
window.replayTest = { disconnect: () => socket.close(), connect };
