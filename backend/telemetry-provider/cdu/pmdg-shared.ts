import type { CduAdapter, CduColor, CduScreen, CduSide } from './types.js';
const { SdkBridge } = require('../sdk-bridge.js');
const { createClientdataManifestAdapter } = require('../sdk-adapters/clientdata-manifest.js');

/** Shared 737/777 SDK layout: 24 columns, 14 rows, three bytes per cell, power byte. */
export function decodePmdgScreen(raw: unknown): CduScreen | null {
  if (!Array.isArray(raw) || raw.length !== 1009 || !raw.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
      || raw[1008] > 1) return null;
  const colors: CduColor[] = ['white', 'cyan', 'green', 'magenta', 'amber', 'red'];
  const symbols: Record<number, string> = { 0: ' ', 0xa1: '←', 0xa2: '→', 0xa3: '↑', 0xa4: '↓' };
  return { powered: raw[1008] === 1, rows: Array.from({ length: 14 }, (_, row) =>
    Array.from({ length: 24 }, (_, column) => {
      const offset = (column * 14 + row) * 3; // SDK layout is column-major.
      const symbol = raw[offset], flags = raw[offset + 2];
      return { text: symbols[symbol] ?? (symbol >= 32 ? String.fromCharCode(symbol) : ' '),
        color: colors[raw[offset + 1]] || 'white', small: Boolean(flags & 1), reverse: Boolean(flags & 2), dim: Boolean(flags & 4) };
    })) };
}

type Bridge = { start(): Promise<void>; connect(target: { channel: string } | null): void;
  getSnapshot(): { raw?: Record<string, unknown>; error?: string }; isDataConnected(): boolean; stop(): Promise<void> };

export type PmdgTransportOptions = { sendEvent: (name: string, value: number) => Promise<{ ok: boolean; error?: string }>;
  createBridge?: (side: CduSide) => Bridge; now?: () => number };
type PmdgSpec = Pick<CduAdapter, 'label' | 'setup' | 'functionKeys' | 'entryKeys'> & {
  channelPrefix: string; event: (side: CduSide, key: string) => string | null;
};

export function createPmdgTransport(spec: PmdgSpec, { sendEvent, now = Date.now, createBridge = (side: CduSide): Bridge => new SdkBridge({
  ...createClientdataManifestAdapter(), id: `${spec.channelPrefix}-${side}`, pidFileName: `flight-fabric-${spec.channelPrefix}-${side}.pid`,
}) }: PmdgTransportOptions): CduAdapter {
  const bridges = new Map<CduSide, Bridge>();
  const starts = new Map<CduSide, Promise<void>>();
  const attemptedAt = new Map<CduSide, number>();
  let disposed = false;
  return {
    label: spec.label, setup: spec.setup, functionKeys: spec.functionKeys, entryKeys: spec.entryKeys,
    async read(side) {
      if (disposed) return null;
      let bridge = bridges.get(side);
      if (!bridge) {
        bridge = createBridge(side);
        bridges.set(side, bridge);
      }
      if (!starts.has(side) || (!bridge.isDataConnected() && now() - attemptedAt.get(side)! >= 5000)) {
        attemptedAt.set(side, now());
        const current = bridge;
        starts.set(side, current.start().then(() => {
          if (!disposed) current.connect({ channel: `${spec.channelPrefix}-${side}` });
        }));
      }
      await starts.get(side);
      if (disposed || !bridge.isDataConnected()) return null;
      return decodePmdgScreen(bridge.getSnapshot().raw?.screen);
    },
    async press(side, key, isCurrent) {
      const event = spec.event(side, key);
      const bridge = bridges.get(side);
      if (!event || !isCurrent() || !bridge?.isDataConnected() || !decodePmdgScreen(bridge.getSnapshot().raw?.screen)?.powered) throw new Error('PMDG CDU data is unavailable.');
      let failure: unknown = null;
      try {
        const down = await sendEvent(event, 0x20000000);
        if (!down?.ok) failure = new Error(down?.error || 'CDU press was not acknowledged.');
      } catch (error) { failure = error; }
      // A release is attempted after a sent press, including an uncertain acknowledgement.
      // Never send the release into a different aircraft/profile generation.
      try {
        const up = isCurrent() ? await sendEvent(event, 0x00020000) : null;
        if (!up?.ok) failure ??= new Error(up?.error || 'CDU release was not acknowledged.');
      } catch (error) { failure ??= error; }
      if (failure) throw new Error('CDU key delivery was not confirmed. Check the aircraft before trying again.');
    },
    async dispose() {
      disposed = true;
      const results = await Promise.allSettled([...bridges.values()].map(bridge => bridge.stop()));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
  };
}
