import { createAutotaxi } from './aircraft-autotaxi.js';
import { createPushbackSession, type PushbackCommand } from '../autotaxi/pushback-session.js';
import { createPushbackPreviews, type PreparedPushback } from '../autotaxi/pushback-preview.js';

// SDK TUG_HEADING is a full unsigned DWORD representing 0..360 degrees.
// Keep it unsigned through SimConnect; never wrap it through JS bitwise operators.
export function tugHeading(headingDeg: number): number {
  if (!Number.isFinite(headingDeg)) throw new Error('Invalid pushback heading.');
  return Math.round((((headingDeg % 360) + 360) % 360) / 360 * 0xffffffff);
}

export async function writeSimulatorTug(bridge: { sendEvent: (name: string, value: number) => Promise<any>; startPushback?: () => Promise<any> },
  command: PushbackCommand, valid: () => boolean) {
  const receipts: any[] = [];
  const send = async (name: string, value: number) => {
    if (!valid()) throw new Error('Pushback aircraft or ownership changed.');
    const result = await bridge.sendEvent(name, value);
    if (result?.ok !== true) throw new Error(result?.error || 'Simulator pushback command failed.');
    receipts.push(result);
  };
  if (command.kind === 'stop') {
    await send('TUG_DISABLE', 0);
  } else if (command.kind === 'start') {
    if (!bridge.startPushback) throw new Error('Update the simulator bridge before using pushback.');
    // Fresh inactive tug readback is checked before each await. Explicit start
    // clears an expired lease, then toggles exactly once. Never retry a toggle.
    await send('TUG_DISABLE', 0);
    if (!valid()) throw new Error('Pushback aircraft or ownership changed.');
    const result = await bridge.startPushback();
    if (result?.ok !== true) throw new Error(result?.error || 'Simulator pushback start failed.');
    receipts.push(result);
  } else if (command.kind === 'steer') {
    await send('TUG_HEADING', tugHeading(command.headingDeg));
  }
  return receipts;
}

export function createAircraftPushback(provider: Record<string, any>, profiles: Record<string, any>, now = Date.now) {
  const ground = createAutotaxi(provider, profiles, now, { readOnly: true }).groundContext;
  const observation = { now, ...ground, capture: () => ({ ...ground.capture(), parked: ground.parked(), tug: ground.tug() }) };
  const previews = createPushbackPreviews(observation);
  let activePlan: PreparedPushback | null = null;
  let pendingPackets: { ids: number[]; at: number }[] = [];
  const session = createPushbackSession({ ...observation,
    conflict: () => provider._autotaxi?.isActive() === true,
    async write(command, valid) {
      if (!valid()) throw new Error('Pushback aircraft or ownership changed.');
      const bridge = provider._lvarBridge || await provider._ensureControlWriteBridge?.();
      if (!valid()) throw new Error('Pushback aircraft or ownership changed.');
      if (!bridge?.sendEvent) throw new Error('Simulator pushback control is unavailable.');
      if (command.kind !== 'stop' && pendingPackets.some(packet => bridge.findRecentSimConnectException?.(packet.ids, packet.at))) {
        throw new Error('The simulator rejected a pushback command.');
      }
      const at = Date.now();
      const receipts = await writeSimulatorTug(bridge, command, valid);
      if (command.kind === 'stop') pendingPackets = [];
      else {
        pendingPackets.push({ at, ids: receipts.flatMap(ack => ack.sendIds || (Number.isInteger(ack.sendId) ? [ack.sendId] : [])) });
        pendingPackets = pendingPackets.slice(-16);
      }
    },
  });
  return { ...session,
    request: async (message: Record<string, any>, client: object, connected: () => boolean) => {
      if (message.operation !== 'start' || session.isActive()) return session.request(message, client, connected);
      const previous = activePlan;
      activePlan = previews.prepared(message, client);
      try { return await session.request(message, client, connected, activePlan); }
      catch (error) { if (!session.isActive()) activePlan = previous; throw error; }
    },
    preview: (message: Record<string, any>, client: object, connected: () => boolean) => {
      // Observing an active manoeuvre never renews its owner's control lease.
      const state = session.state();
      if (connected() && activePlan && previews.matches(activePlan, message)
        && (state.active || state.status === 'complete')) {
        return previews.view(activePlan, message.operation === 'preview' || message.scene === true, state.status, state.remainingM);
      }
      return previews.request(message, client, connected);
    },
  };
}
