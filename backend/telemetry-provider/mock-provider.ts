'use strict';

const { getMockFrame } = require('../../tests/backend/mock-flight.js') as {
  getMockFrame: () => MockFrame;
};
type SimConnectState = {
  available: boolean;
  connected: boolean;
  simRunning: boolean;
  flightLoaded: string | null;
  flightLoadedFile: string | null;
  aircraftLoadedName: string;
  userInputEnabled: boolean;
  inFlightContext: boolean;
  inFlightContextAt: string | null;
  inFlightContextSource: string;
  lastEvent: string;
  lastEventAt: string | null;
  applicationName: string;
  lat: number | null;
  lon: number | null;
  gpsUpdatedAt: string | null;
};

type MockSimConnectProvider = {
  start: () => Promise<void>;
  stop: () => void;
  getState: () => SimConnectState;
  isAvailable: () => boolean;
  getGps: () => { lat: number | null; lon: number | null };
};

type EngineSnapshot = {
  count: number;
  source: string;
  eng1: number | null;
  eng2: number | null;
  eng3: number | null;
  eng4: number | null;
  eng1Text: string;
  eng2Text: string;
  eng3Text: string;
  eng4Text: string;
};

type ThrottleSnapshot = {
  eng1Pct: number | null;
  eng2Pct: number | null;
  eng3Pct: number | null;
  eng4Pct: number | null;
  avgPct: number;
  counts: number | null;
  detent: string | null;
  gateActive: boolean;
  profileId: string;
  servoEnabled: boolean;
  detentLabel?: string | null;
  detentCounts?: number | null;
};

type MockFrame = Record<string, unknown> & {
  simconnect?: SimConnectState;
  gpsSource?: string;
  spoilers?: number | { percent: number; fraction: number; state: string };
  flaps?: number;
  throttle?: ThrottleSnapshot;
  engines?: EngineSnapshot;
};

type MockRunnerLike = {
  getFlapsOverrideNotch?: () => number | null;
};

function syntheticThrottlePercent(timeMs: number): number {
  const periodMs = 8000;
  const halfPeriodMs = periodMs / 2;
  const t = Math.abs(timeMs % periodMs);
  return t < halfPeriodMs
    ? (t / halfPeriodMs) * 100
    : (1 - ((t - halfPeriodMs) / halfPeriodMs)) * 100;
}

function createMockThrottleSnapshot(timeMs: number): ThrottleSnapshot {
  const pct = syntheticThrottlePercent(timeMs);
  return {
    eng1Pct: pct,
    eng2Pct: pct,
    eng3Pct: null,
    eng4Pct: null,
    avgPct: pct,
    counts: null,
    detent: null,
    gateActive: false,
    profileId: 'mock',
    servoEnabled: false,
  };
}

function createMockSimConnectProvider(
  { now = () => new Date().toISOString() }: { now?: () => string } = {},
): MockSimConnectProvider {
  const base: SimConnectState = {
    available: true,
    connected: true,
    simRunning: true,
    flightLoaded: null,
    flightLoadedFile: null,
    aircraftLoadedName: 'MOCK',
    userInputEnabled: true,
    inFlightContext: true,
    inFlightContextAt: null,
    inFlightContextSource: 'mock',
    lastEvent: 'mock',
    lastEventAt: null,
    applicationName: 'mock',
    lat: null,
    lon: null,
    gpsUpdatedAt: null,
  };

  return {
    async start(): Promise<void> {},
    stop(): void {},
    getState(): SimConnectState {
      const ts = now();
      return {
        ...base,
        inFlightContextAt: ts,
        lastEventAt: ts,
      };
    },
    isAvailable(): boolean {
      return true;
    },
    getGps(): { lat: number | null; lon: number | null } {
      return { lat: null, lon: null };
    },
  };
}

class MockProvider {
  _simconnect: MockSimConnectProvider | null;
  _onBroadcast: ((payload: unknown) => void) | null;
  _runner: MockRunnerLike | null;
  capabilities: {
    isMock: boolean;
    enableLandingRunner: boolean;
  };

  constructor() {
    this._simconnect = null;
    this._onBroadcast = null;
    this._runner = null;
    this.capabilities = {
      isMock: true,
      enableLandingRunner: false,
    };
  }

  setBroadcast(fn: (payload: unknown) => void): void {
    this._onBroadcast = fn;
  }

  async start(): Promise<void> {
    console.log('Running in MOCK mode.');

    try {
      this._simconnect = createMockSimConnectProvider();
      await this._simconnect.start();
    } catch {}
  }

  async nextFrame(): Promise<MockFrame> {
    const frame = getMockFrame();

    try {
      if (this._simconnect && typeof this._simconnect.getState === 'function') {
        frame.simconnect = this._simconnect.getState();
      }
    } catch {}

    frame.gpsSource = 'mock';

    if (!frame.spoilers) {
      frame.spoilers = { percent: 0, fraction: 0, state: 'STOWED' };
    }

    const overrideNotch = this._runner?.getFlapsOverrideNotch?.() ?? null;
    if (typeof overrideNotch === 'number') {
      frame.flaps = Math.max(0, Math.min(30, overrideNotch));
    }

    try {
      const thr = createMockThrottleSnapshot(Date.now());
      if (thr) frame.throttle = thr;

      const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
      const fmtPct = (v: number | null): string => (Number.isFinite(v) ? `${Math.round(v as number)}%` : '--');
      const e1 = typeof thr?.eng1Pct === 'number' ? clamp(thr.eng1Pct, 0, 100) : null;
      const e2 = typeof thr?.eng2Pct === 'number' ? clamp(thr.eng2Pct, 0, 100) : null;
      const e3 = typeof thr?.eng3Pct === 'number' ? clamp(thr.eng3Pct, 0, 100) : null;
      const e4 = typeof thr?.eng4Pct === 'number' ? clamp(thr.eng4Pct, 0, 100) : null;
      const count = (() => {
        if (typeof e4 === 'number') return 4;
        if (typeof e3 === 'number') return 3;
        if (typeof e2 === 'number') return 2;
        if (typeof e1 === 'number') return 1;
        return 0;
      })();

      if (count > 0) {
        frame.engines = {
          count,
          source: 'throttle',
          eng1: e1,
          eng2: e2,
          eng3: e3,
          eng4: e4,
          eng1Text: fmtPct(e1),
          eng2Text: fmtPct(e2),
          eng3Text: fmtPct(e3),
          eng4Text: fmtPct(e4),
        };
      }
    } catch {}

    return frame;
  }
}

const mockProviderApi = { MockProvider };

module.exports = mockProviderApi;

export {};
