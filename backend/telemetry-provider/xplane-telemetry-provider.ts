const http = require('http') as typeof import('http');
const https = require('https') as typeof import('https');
const WebSocket = require('ws') as new (url: string) => WsInstance;

const config = require('../core/config') as ConfigModule;
const eventBus = require('../core/event-bus') as EventBusModule;
const { decodeSurfaceType } = require('../utils/helpers') as HelpersModule;

type ConfigModule = {
  xplane: {
    host: string;
    port: number;
  };
};

type HelpersModule = {
  decodeSurfaceType: (surfaceType: number, wow: boolean, fallback: unknown) => unknown;
};

type EventBusModule = {
  emit: (eventName: string, payload: unknown) => void;
};

type AnyRecord = Record<string, any>;

type BroadcastFn = ((payload: Record<string, unknown>) => void) | null;

type WsInstance = {
  on: (eventName: string, handler: (...args: any[]) => void) => void;
  send: (payload: string) => void;
  close: () => void;
  removeAllListeners: () => void;
};

type DatarefSpec = {
  key: string;
  path: string;
  fallbackPaths?: string[];
  index?: number[];
  required?: boolean;
  stringData?: boolean;
};

type ResolvedDatarefSpec = DatarefSpec & {
  id: number;
};

type CapabilitiesInfo = {
  apiVersions: unknown[];
  xplaneVersion: string | null;
};

type XPlaneAircraftIdentity = {
  acfPath: string | null;
  acfFileName: string | null;
  id: string | null;
  displayName: string | null;
};

const FT_TO_M = 0.3048;
const M_TO_FT = 3.28084;
const MPS_TO_KTS = 1.94384;
const FPM_TO_MPS = 0.00508;
const MPS_TO_FPM = 1 / FPM_TO_MPS;
const KG_TO_LBS = 2.2046226218;
const DEG_TO_RAD = Math.PI / 180;
const RECONNECT_DELAY_MS = 2000;
const HTTP_TIMEOUT_MS = 5000;
const HTTP_RESPONSE_MAX_BYTES = 1024 * 1024;
const XPLANE_SPOILER_STOWED_DEADBAND_RATIO = 0.05;

const DATAREF_SPECS = Object.freeze([
  { key: 'iasKts', path: 'sim/cockpit2/gauges/indicators/airspeed_kts_pilot' },
  // Use physical vertical velocity for landing-rate fidelity. The cockpit VVI
  // is an indicated value and can lag the actual aircraft motion in the flare.
  { key: 'verticalVelocityMs', path: 'sim/flightmodel/position/local_vy' },
  { key: 'indicatedVsFpm', path: 'sim/flightmodel/position/vh_ind_fpm', required: false },
  { key: 'raFt', path: 'sim/cockpit2/gauges/indicators/radio_altimeter_height_ft_pilot' },
  { key: 'wow', path: 'sim/flightmodel/failures/onground_any' },
  { key: 'gsMs', path: 'sim/flightmodel/position/groundspeed' },
  { key: 'latDeg', path: 'sim/flightmodel/position/latitude' },
  { key: 'lonDeg', path: 'sim/flightmodel/position/longitude' },
  { key: 'flapsRatio', path: 'sim/cockpit2/controls/flap_handle_deploy_ratio' },
  { key: 'flapsSystemRatio', path: 'sim/cockpit2/controls/flap_system_deploy_ratio', required: false },
  { key: 'flapsAngleDeg', path: 'sim/flightmodel2/wing/flap1_deg', index: [0, 1, 2, 3], required: false },
  { key: 'gearHandleDown', path: 'sim/cockpit2/controls/gear_handle_down', required: false },
  { key: 'gearDeploy', path: 'sim/flightmodel2/gear/deploy_ratio', index: [0, 1, 2] },
  { key: 'parkingBrakeRatio', path: 'sim/flightmodel/controls/parkbrake', required: false },
  { key: 'spoilersRatio', path: 'sim/cockpit2/controls/speedbrake_ratio' },
  { key: 'lightNav', path: 'sim/cockpit/electrical/nav_lights_on', required: false },
  { key: 'lightBeacon', path: 'sim/cockpit/electrical/beacon_lights_on', required: false },
  { key: 'lightLanding', path: 'sim/cockpit/electrical/landing_lights_on', required: false },
  { key: 'lightTaxi', path: 'sim/cockpit/electrical/taxi_light_on', required: false },
  { key: 'lightStrobe', path: 'sim/cockpit/electrical/strobe_lights_on', required: false },
  { key: 'aircraftAcfRelativePath', path: 'sim/aircraft/view/acf_relative_path', required: false, stringData: true },
  { key: 'aircraftDescription', path: 'sim/aircraft/view/acf_descrip', required: false, stringData: true },
  { key: 'aircraftIcao', path: 'sim/aircraft/view/acf_ICAO', required: false, stringData: true },
  { key: 'pitchDeg', path: 'sim/flightmodel/position/true_theta' },
  { key: 'bankDeg', path: 'sim/flightmodel/position/true_phi' },
  { key: 'headingTrueDeg', path: 'sim/flightmodel/position/true_psi' },
  { key: 'headingMagDeg', path: 'sim/flightmodel/position/mag_psi' },
  { key: 'magvarDeg', path: 'sim/flightmodel/position/magnetic_variation' },
  { key: 'engineN1', path: 'sim/flightmodel2/engines/N1_percent', index: [0, 1, 2, 3] },
  { key: 'oatC', path: 'sim/cockpit2/temperature/outside_air_temp_degc' },
  { key: 'runwayFriction', path: 'sim/weather/region/runway_friction', required: false },
  { key: 'fuelTotalKg', path: 'sim/flightmodel/weight/m_fuel_total' },
  { key: 'altMslM', path: 'sim/flightmodel/position/elevation' },
  { key: 'gForce', path: 'sim/flightmodel/forces/g_nrml', required: false },
  { key: 'paused', path: 'sim/time/paused' },
  {
    key: 'windSpeedMs',
    path: 'sim/weather/aircraft/wind_now_speed_msc',
    fallbackPaths: ['sim/weather/wind_speed_kt'],
    required: false,
  },
  {
    key: 'windDirTrueDeg',
    path: 'sim/weather/aircraft/wind_now_direction_degt',
    fallbackPaths: ['sim/weather/wind_direction_degt'],
    required: false,
  },
]);

function truncate(str: unknown, maxLen = 200): string {
  if (typeof str !== 'string') return '';
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}...`;
}

function requestJson(urlString: string, { timeoutMs = HTTP_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<AnyRecord> {
  return new Promise<AnyRecord>((resolve, reject) => {
    let settled = false;
    const url = new URL(urlString);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let body = '';
      let bodyBytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bodyBytes += Buffer.byteLength(String(chunk), 'utf8');
        if (bodyBytes > HTTP_RESPONSE_MAX_BYTES) {
          if (settled) return;
          settled = true;
          reject(new Error('X-Plane HTTP response exceeded 1 MB'));
          req.destroy();
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;

        const statusCode = res.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`HTTP ${statusCode}: ${truncate(body)}`));
          return;
        }

        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          reject(new Error(`Invalid JSON response: ${errorMessage}`));
        }
      });
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      req.destroy(new Error('Request timed out'));
    });

    req.end();
  });
}

function toFiniteNumber(value: unknown, fallback: number): number;
function toFiniteNumber(value: unknown, fallback?: null): number | null;
function toFiniteNumber(value: unknown, fallback: number | null = null): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function cleanDecodedStringData(value: string): string | null {
  const withoutNulls = value.replace(/\0.*$/, '').trim();
  if (!withoutNulls || withoutNulls.includes('\uFFFD')) return null;
  if (/[\x00-\x08\x0E-\x1F\x7F]/.test(withoutNulls)) return null;
  return withoutNulls;
}

function maybeDecodeBase64StringData(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;

  const compact = trimmed.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
    return value;
  }

  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, '=');
  try {
    const buffer = Buffer.from(padded, 'base64');
    if (buffer.length === 0) return value;

    const canonicalInput = compact.replace(/=+$/, '');
    const canonicalDecoded = buffer.toString('base64').replace(/=+$/, '');
    if (canonicalDecoded !== canonicalInput) return value;

    const decoded = cleanDecodedStringData(buffer.toString('utf8'));
    return decoded || value;
  } catch {
    return value;
  }
}

function decodeStringDataValue(value: unknown): unknown {
  if (typeof value === 'string') return maybeDecodeBase64StringData(value);

  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    const decoded = cleanDecodedStringData(Buffer.from(value as number[]).toString('utf8'));
    return decoded || value;
  }

  return value;
}

function toCleanString(value: unknown): string | null {
  const decoded = decodeStringDataValue(value);
  if (decoded !== value) return toCleanString(decoded);

  if (Array.isArray(value)) {
    for (const item of value) {
      const cleaned = toCleanString(item);
      if (cleaned) return cleaned;
    }
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  return null;
}

function normalizeXplanePath(value: unknown): string | null {
  const cleaned = toCleanString(value);
  if (!cleaned) return null;
  return cleaned.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function getBaseName(value: string | null): string | null {
  if (!value) return null;
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function toIdentitySlug(value: string | null): string | null {
  if (!value) return null;
  const slug = value
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.acf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || '';
  return slug || null;
}

function toBoolOrNull(value: unknown): boolean | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
  }

  const num = toFiniteNumber(value, null);
  if (num != null) return num !== 0;

  return Boolean(value);
}

function safeArray(values: unknown, length: number): Array<number | null> {
  const out = new Array<number | null>(length).fill(null);
  if (!Array.isArray(values)) return out;
  for (let i = 0; i < Math.min(values.length, length); i += 1) {
    out[i] = toFiniteNumber(values[i], null);
  }
  return out;
}

function maxFiniteValue(value: unknown, fallback: number | null = null): number | null {
  if (Array.isArray(value)) {
    let best = fallback;
    for (const item of value) {
      const num = toFiniteNumber(item, null);
      if (num == null) continue;
      if (best == null || num > best) best = num;
    }
    return best;
  }
  return fallback == null
    ? toFiniteNumber(value, null)
    : toFiniteNumber(value, fallback);
}

function toLightBoolean(value: unknown): boolean | null {
  if (Array.isArray(value)) {
    let sawFinite = false;
    for (const item of value) {
      const num = toFiniteNumber(item, null);
      if (num == null) continue;
      sawFinite = true;
      if (num !== 0) return true;
    }
    return sawFinite ? false : null;
  }

  const num = toFiniteNumber(value, null);
  return num == null ? null : num !== 0;
}

function buildLightsUnavailable() {
  return {
    nav: false,
    beacon: false,
    landing: false,
    taxi: false,
    strobe: false,
    panel: null,
    recog: false,
    turnoff: false,
    wing: false,
    logo: false,
    cabin: false,
    raw: null,
    available: false,
  };
}

function buildLightsFromDatarefs(d: Record<string, unknown>) {
  const nav = toLightBoolean(d.lightNav);
  const beacon = toLightBoolean(d.lightBeacon);
  const landing = toLightBoolean(d.lightLanding);
  const taxi = toLightBoolean(d.lightTaxi);
  const strobe = toLightBoolean(d.lightStrobe);

  const raw = {
    nav: d.lightNav ?? null,
    beacon: d.lightBeacon ?? null,
    landing: d.lightLanding ?? null,
    taxi: d.lightTaxi ?? null,
    strobe: d.lightStrobe ?? null,
  };

  if ([nav, beacon, landing, taxi, strobe].every((value) => value == null)) {
    return buildLightsUnavailable();
  }

  return {
    nav: nav === true,
    beacon: beacon === true,
    landing: landing === true,
    taxi: taxi === true,
    strobe: strobe === true,
    panel: null,
    recog: null,
    turnoff: null,
    // Laminar does not publish dedicated global logo/wing light datarefs.
    // Generic-light indices are aircraft-defined, so these cannot be mapped
    // authoritatively by a simulator-wide provider.
    wing: null,
    logo: null,
    cabin: null,
    raw,
    available: true,
    _source: 'xplane',
  };
}

function buildXplaneAircraftIdentity(d: Record<string, unknown>): XPlaneAircraftIdentity | null {
  const acfPath = normalizeXplanePath(d.aircraftAcfRelativePath);
  const acfFileName = getBaseName(acfPath);
  const displayName = toCleanString(d.aircraftDescription);
  const id = toIdentitySlug(acfPath)
    || toIdentitySlug(acfFileName);

  if (!acfPath && !acfFileName && !displayName && !id) return null;

  return {
    acfPath,
    acfFileName,
    id,
    displayName,
  };
}

function getIdentityKey(identity: XPlaneAircraftIdentity | null): string {
  if (!identity) return '';
  return [
    identity.acfPath || '',
    identity.acfFileName || '',
    identity.id || '',
    identity.displayName || '',
  ].join('|');
}

function getIdentityTitle(identity: XPlaneAircraftIdentity | null): string | null {
  if (!identity) return null;
  return identity.displayName || identity.acfPath || identity.acfFileName || identity.id || null;
}

function buildSpoilersFromRatio(rawRatio: unknown) {
  const ratio = toFiniteNumber(rawRatio, 0);
  if (ratio < 0) {
    return {
      percent: 0,
      fraction: 0,
      state: 'ARMED',
      _source: 'xplane',
    };
  }

  const clamped = Math.max(0, Math.min(1, ratio));
  if (clamped <= XPLANE_SPOILER_STOWED_DEADBAND_RATIO) {
    return {
      percent: 0,
      fraction: 0,
      state: 'STOWED',
      _source: 'xplane',
    };
  }

  const percent = clamped * 100;
  return {
    percent: Math.round(percent),
    fraction: clamped,
    state: 'EXTENDED',
    _source: 'xplane',
  };
}

function buildEnginesFromN1(values: unknown) {
  const n1 = safeArray(values, 4);
  let count = 0;
  for (let i = n1.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(n1[i])) {
      count = i + 1;
      break;
    }
  }

  if (count === 0) return null;

  const fmt = (value: number | null): string => (Number.isFinite(value) ? `${Math.round(value as number)}%` : '--');
  return {
    count,
    source: 'xplane',
    eng1: n1[0],
    eng2: n1[1],
    eng3: n1[2],
    eng4: n1[3],
    eng1Text: fmt(n1[0]),
    eng2Text: fmt(n1[1]),
    eng3Text: fmt(n1[2]),
    eng4Text: fmt(n1[3]),
  };
}

class XPlaneTelemetryProvider {
  _host: string;
  _port: number;
  _httpBaseUrl: string;
  _apiVersion: string;
  _restBaseUrl: string;
  _wsUrl: string;
  _available: boolean;
  _connected: boolean;
  _stopped: boolean;
  _started: boolean;
  _connectLoopPromise: Promise<void> | null;
  _reconnectTimer: ReturnType<typeof setTimeout> | null;
  _ws: WsInstance | null;
  _onBroadcast: BroadcastFn;
  _nextReqId: number;
  _capabilitiesInfo: CapabilitiesInfo | null;
  _resolvedSpecs: ResolvedDatarefSpec[];
  _data: Record<string, unknown>;
  _lastAircraftIdentity: XPlaneAircraftIdentity | null;
  _lastAircraftIdentityKey: string;
  capabilities: {
    isMock: boolean;
    enableLandingRunner: boolean;
  };

  constructor({
    host = config.xplane.host,
    port = config.xplane.port,
  }: { host?: string; port?: number } = {}) {
    this._host = host;
    this._port = port;
    this._httpBaseUrl = `http://${host}:${port}`;
    // X-Plane 12.1.1 introduced Web API v1. Do not assume v3, which only
    // exists from X-Plane 12.4.0 onward; capabilities negotiation upgrades
    // these endpoints when the running simulator advertises a newer version.
    this._apiVersion = 'v1';
    this._restBaseUrl = `${this._httpBaseUrl}/api/${this._apiVersion}`;
    this._wsUrl = `ws://${host}:${port}/api/${this._apiVersion}`;

    this._available = false;
    this._connected = false;
    this._stopped = false;
    this._started = false;
    this._connectLoopPromise = null;
    this._reconnectTimer = null;
    this._ws = null;
    this._onBroadcast = null;
    this._nextReqId = 1;
    this._capabilitiesInfo = null;
    this._resolvedSpecs = [];
    this._data = Object.create(null);
    this._lastAircraftIdentity = null;
    this._lastAircraftIdentityKey = '';

    this.capabilities = {
      isMock: false,
      enableLandingRunner: true,
    };
  }

  setBroadcast(fn: BroadcastFn): void {
    this._onBroadcast = fn;
  }

  getAircraftControlCapabilities() {
    return {
      simulator: 'xplane',
      actionTypes: [],
    };
  }

  async executeAircraftControlAction() {
    return {
      ok: false,
      code: 'not_implemented',
      error: 'Aircraft control actions are not implemented for the X-Plane provider yet.',
    };
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this._stopped = false;
    this._scheduleReconnect(0);
  }

  stop(): void {
    this._stopped = true;
    this._started = false;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._ws) {
      try {
        this._ws.removeAllListeners();
        this._ws.close();
      } catch {}
      this._ws = null;
    }

    this._resetConnectionState();
  }

  isConnected(): boolean {
    return this._connected;
  }

  getSecondaryDataSources(): unknown[] {
    return [];
  }

  _maybeEmitAircraftChanged(identity: XPlaneAircraftIdentity | null): void {
    const identityKey = getIdentityKey(identity);
    if (!identity || !identityKey || identityKey === this._lastAircraftIdentityKey) return;

    const previous = this._lastAircraftIdentity;
    this._lastAircraftIdentity = identity;
    this._lastAircraftIdentityKey = identityKey;

    eventBus.emit('simconnect:aircraftChanged', {
      title: getIdentityTitle(identity),
      displayName: identity.displayName,
      aircraftConfigPath: identity.acfPath,
      previousTitle: getIdentityTitle(previous),
      previousDisplayName: previous?.displayName || null,
      previousAircraftConfigPath: previous?.acfPath || null,
      xplane: {
        acfPath: identity.acfPath,
        acfFileName: identity.acfFileName,
        id: identity.id,
      },
      previousXplane: previous ? {
        acfPath: previous.acfPath,
        acfFileName: previous.acfFileName,
        id: previous.id,
      } : null,
      source: 'xplane-web',
    });
  }

  async nextFrame() {
    const d = this._data;
    const aircraftIdentity = buildXplaneAircraftIdentity(d);
    this._maybeEmitAircraftChanged(aircraftIdentity);

    const paused = toBoolOrNull(d.paused) === true;
    const iasKts = toFiniteNumber(d.iasKts, 0);
    const verticalVelocityMs = toFiniteNumber(d.verticalVelocityMs, null);
    const vsFpm = verticalVelocityMs == null
      ? toFiniteNumber(d.indicatedVsFpm, 0)
      : verticalVelocityMs * MPS_TO_FPM;
    const raFtRaw = toFiniteNumber(d.raFt, 0);
    const raFt = (raFtRaw < 0 || raFtRaw > 100000) ? 0 : raFtRaw;
    const wow = toBoolOrNull(d.wow) === true;
    const gsMs = toFiniteNumber(d.gsMs, 0);
    const gsKts = gsMs * MPS_TO_KTS;
    const lat = toFiniteNumber(d.latDeg, null);
    const lon = toFiniteNumber(d.lonDeg, null);
    const flapsRatio = toFiniteNumber(d.flapsRatio, null) ?? toFiniteNumber(d.flapsSystemRatio, 0);
    const flaps = Math.max(0, Math.min(100, flapsRatio * 100));
    const flapsAngleDeg = maxFiniteValue(d.flapsAngleDeg, null);
    const spoilers = buildSpoilersFromRatio(d.spoilersRatio);

    const gearDeploy = safeArray(d.gearDeploy, 3);
    const gearNose = Math.max(0, Math.min(100, (gearDeploy[0] ?? 0) * 100));
    const gearLeft = Math.max(0, Math.min(100, (gearDeploy[1] ?? 0) * 100));
    const gearRight = Math.max(0, Math.min(100, (gearDeploy[2] ?? 0) * 100));
    const gearDownLocked = (gearNose >= 99 && gearLeft >= 99 && gearRight >= 99) ? 1 : 0;
    const gearHandleValue = toBoolOrNull(d.gearHandleDown);
    const gearHandle = gearHandleValue == null
      ? gearDownLocked
      : (gearHandleValue ? 1 : 0);

    const pitchDeg = toFiniteNumber(d.pitchDeg, 0);
    const bankDeg = toFiniteNumber(d.bankDeg, 0);
    const rawHeadingTrueDeg = toFiniteNumber(d.headingTrueDeg, null);
    const rawHeadingMagDeg = toFiniteNumber(d.headingMagDeg, null);
    const headingTrueDeg = rawHeadingTrueDeg ?? 0;
    const headingMagDeg = rawHeadingMagDeg ?? 0;
    const rawXplaneMagvarDeg = toFiniteNumber(d.magvarDeg, null);
    // The normalized project/MSFS convention is west-positive. X-Plane's
    // declination is east-positive, so invert it. When both documented heading
    // datarefs are present, derive the normalized variation directly from them
    // to avoid depending on an implicit sign convention.
    const magvarDeg = rawHeadingTrueDeg != null && rawHeadingMagDeg != null
      ? (((rawHeadingMagDeg - rawHeadingTrueDeg + 540) % 360) - 180)
      : -(rawXplaneMagvarDeg ?? 0);
    const windSpeed = (() => {
      const rawSpeed = toFiniteNumber(d.windSpeedMs, null);
      if (rawSpeed == null) return null;
      // Both the current XP12 dataref and the replaced compatibility dataref
      // are metres per second. Laminar explicitly documents that the legacy
      // sim/weather/wind_speed_kt name is erroneous; its value is still m/s.
      return rawSpeed * MPS_TO_KTS;
    })();
    const windDir = toFiniteNumber(d.windDirTrueDeg, null);
    const oatC = toFiniteNumber(d.oatC, null);
    const runwayFriction = toFiniteNumber(d.runwayFriction, null);
    // X-Plane exposes total fuel as mass. Do not manufacture a volume using a
    // fixed Jet-A density: fuel type/density is not available in this provider.
    const fuelTotalGal = null;
    const fuelTotalWeightLbs = (() => {
      const fuelKg = toFiniteNumber(d.fuelTotalKg, null);
      return fuelKg == null ? null : fuelKg * KG_TO_LBS;
    })();
    const altMslFt = toFiniteNumber(d.altMslM, 0) * M_TO_FT;
    const gforce = toFiniteNumber(d.gForce, null);
    const raM = raFt * FT_TO_M;
    const vsMs = verticalVelocityMs ?? (vsFpm * FPM_TO_MPS);
    const inFlightContext = this._connected && !paused;
    const engineN1 = safeArray(d.engineN1, 4);
    const engines = buildEnginesFromN1(engineN1);
    const simVersion = this._capabilitiesInfo?.xplaneVersion || null;

    const simconnectFdm = {
      fuelTotalGal,
      fuelTotalWeightLbs,
      eng1N1: engineN1[0],
      eng2N1: engineN1[1],
      eng3N1: engineN1[2],
      eng4N1: engineN1[3],
      oatC,
      xplaneRunwayFriction: runwayFriction,
    };

    const surface = decodeSurfaceType(Number.NaN, wow, null);

    return {
      ias: iasKts,
      vs: vsMs,
      ra: raM,
      wow,
      display: {
        iasKts,
        vsFpm,
        raFt,
        gsKts,
      },
      paused,
      inMenu: !this._connected || paused,
      surface,
      gearHandle,
      gearDownLocked,
      gearLeft,
      gearRight,
      gearNose,
      brake: Math.max(0, Math.min(1, toFiniteNumber(d.parkingBrakeRatio, 0))),
      lights: buildLightsFromDatarefs(d),
      flaps,
      flapsIndex: null,
      flapsAngleDeg,
      spoilers,
      pitch: pitchDeg * DEG_TO_RAD,
      bank: bankDeg * DEG_TO_RAD,
      attitudeValid: true,
      attitudeDebug: {
        pitchSource: 'xplane',
        bankSource: 'xplane',
        pitchDegPrimary: pitchDeg,
        bankDegPrimary: bankDeg,
      },
      gs: gsKts,
      windSpeed,
      windDir,
      heading: headingTrueDeg,
      magvar: magvarDeg,
      lat,
      lon,
      gpsSource: 'xplane',
      alt_msl: altMslFt,
      engines,
      throttle: null,
      gforce,
      simconnect: {
        available: this._available,
        connected: this._connected,
        simRunning: this._connected,
        inFlightContext,
        systemSim: null,
        dialogMode: null,
        systemStateAvailable: false,
        cameraState: null,
        cameraUserControl: null,
        crashFlag: null,
        crashSequence: null,
        crashActive: false,
        lat,
        lon,
        aircraftLoadedName: getIdentityTitle(aircraftIdentity),
        xplane: aircraftIdentity ? {
          acfPath: aircraftIdentity.acfPath,
          acfFileName: aircraftIdentity.acfFileName,
          id: aircraftIdentity.id,
        } : null,
        hdgTrueDeg: headingTrueDeg,
        hdgMagDeg: headingMagDeg,
        magvarDeg,
        simVersion,
        applicationName: 'X-Plane Web API',
        fdm: simconnectFdm,
      },
      fdm: {
        gForce: gforce,
        oatC,
        xplaneRunwayFriction: runwayFriction,
        pressureAltFt: null,
        cabinAltFt: null,
        cabinAltRateFpm: null,
        cabinAltTargetFt: null,
        fuelTotalGal,
        fuelTotalWeightLbs,
        eng1N1: engineN1[0],
        eng2N1: engineN1[1],
        eng3N1: engineN1[2],
        eng4N1: engineN1[3],
        anyEngineRunning: engineN1.some((value) => typeof value === 'number' && value > 1),
      },
      assists: {
        unlimitedFuel: null,
        realismPercent: null,
        landingAssist: null,
        takeoffAssist: null,
        aiControls: null,
        aiAutotrim: null,
        aiDelegated: null,
        aiAntistall: null,
        aiAntistallActive: null,
        taxiRibbons: null,
        slewActive: null,
        anyAssistActive: null,
        fullRealism: null,
      },
      warnings: {
        overspeed: null,
        stall: null,
      },
      lvars: {
        enabled: false,
        profileId: 'generic',
        source: 'disabled',
        status: 'disabled',
        subscriptions: [],
        values: {},
        updatedAt: null,
        error: null,
      },
      sdk: {
        source: 'disabled',
        status: 'disabled',
        values: {},
        updatedAt: null,
        error: null,
      },
    };
  }

  _scheduleReconnect(delayMs = RECONNECT_DELAY_MS): void {
    if (this._stopped || this._reconnectTimer || this._connectLoopPromise) return;
    const timer = setTimeout(() => {
      this._reconnectTimer = null;
      this._ensureConnectLoop().catch(() => {});
    }, delayMs);
    this._reconnectTimer = timer;
    timer.unref?.();
  }

  async _ensureConnectLoop(): Promise<void> {
    if (this._stopped) return;
    if (this._connectLoopPromise) return this._connectLoopPromise;

    this._connectLoopPromise = (async () => {
      while (!this._stopped && !this._connected) {
        try {
          await this._connectOnce();
          return;
        } catch (err) {
          this._resetConnectionState();
          if (this._stopped) return;
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.warn(`[XPlaneTelemetry] Connection attempt failed: ${errorMessage}`);
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, RECONNECT_DELAY_MS);
            timer.unref?.();
          });
        }
      }
    })();

    try {
      await this._connectLoopPromise;
    } finally {
      this._connectLoopPromise = null;
    }
  }

  async _connectOnce(): Promise<void> {
    await this._fetchCapabilities();
    this._resolvedSpecs = await this._resolveDatarefs();
    await this._openSocketAndSubscribe();
  }

  async _fetchCapabilities(): Promise<void> {
    let json: AnyRecord | null = null;
    try {
      json = await requestJson(`${this._httpBaseUrl}/api/capabilities`);
    } catch (err) {
      // /api/capabilities is only available in Web API v2+ (XP 12.1.4+).
      // Phase 1 targets XP 12.1.1+, so a 404/endpoint miss should not block v1.
      const message = err instanceof Error ? err.message : String(err);
      const missingCapabilities = message.includes('HTTP 404') || message.includes('HTTP 400');
      if (!missingCapabilities) throw err;
    }

    const versions = Array.isArray(json?.api?.versions)
      ? json.api.versions
      : Array.isArray(json?.data?.api?.versions)
        ? json.data.api.versions
        : [];

    const advertisedVersions = versions
      .map((version) => String(version).trim().toLowerCase())
      .filter((version) => /^v\d+$/.test(version))
      .sort((left, right) => Number(right.slice(1)) - Number(left.slice(1)));
    this._apiVersion = advertisedVersions[0] || 'v1';
    this._restBaseUrl = `${this._httpBaseUrl}/api/${this._apiVersion}`;
    this._wsUrl = `ws://${this._host}:${this._port}/api/${this._apiVersion}`;

    this._capabilitiesInfo = {
      apiVersions: versions,
      xplaneVersion: json?.['x-plane']?.version || json?.data?.['x-plane']?.version || null,
    };
    this._available = true;
  }

  async _resolveDatarefs(): Promise<ResolvedDatarefSpec[]> {
    const names = DATAREF_SPECS.flatMap((spec) => [spec.path, ...(spec.fallbackPaths || [])]);
    const fetchExactNames = async (requestedNames: string[]): Promise<AnyRecord[]> => {
      const query = requestedNames.map((name) => `filter[name]=${encodeURIComponent(name)}`).join('&');
      const json = await requestJson(`${this._restBaseUrl}/datarefs?${query}`);
      return Array.isArray(json?.data) ? json.data : [];
    };

    let items: AnyRecord[];
    try {
      items = await fetchExactNames(names);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('HTTP 404')) throw error;

      // The official API permits a 404 for a name that is not registered.
      // Retry names separately so an absent optional dataref (or one side of a
      // version fallback) cannot prevent the provider from connecting.
      const results: AnyRecord[][] = [];
      const lookupBatchSize = 6;
      for (let index = 0; index < names.length; index += lookupBatchSize) {
        const lookupBatch = names.slice(index, index + lookupBatchSize);
        const batchResults = await Promise.all(lookupBatch.map(async (name) => {
          try {
            return await fetchExactNames([name]);
          } catch (singleError) {
            const singleMessage = singleError instanceof Error ? singleError.message : String(singleError);
            if (singleMessage.includes('HTTP 404')) return [];
            throw singleError;
          }
        }));
        results.push(...batchResults);
      }
      items = results.flat();
    }
    const byName = new Map(items.map((item) => [item?.name || item?.attributes?.name, item]));

    const resolved: ResolvedDatarefSpec[] = [];
    const missing: string[] = [];

    for (const spec of DATAREF_SPECS) {
      const candidatePaths = [spec.path, ...(spec.fallbackPaths || [])];
      const resolvedPath = candidatePaths.find((candidate) => {
        const candidateItem = byName.get(candidate);
        return Number.isFinite(Number(candidateItem?.id ?? candidateItem?.attributes?.id));
      });
      const item = resolvedPath ? byName.get(resolvedPath) : null;
      const id = Number(item?.id ?? item?.attributes?.id);
      if (!Number.isFinite(id)) {
        if (spec.required !== false) {
          missing.push(spec.path);
        }
        continue;
      }
      resolved.push({ ...spec, path: resolvedPath as string, id });
    }

    if (missing.length > 0) {
      throw new Error(`Missing required datarefs: ${missing.join(', ')}`);
    }

    return resolved;
  }

  _openSocketAndSubscribe(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this._stopped) {
        reject(new Error('Provider stopped'));
        return;
      }

      let settled = false;
      const ws = new WebSocket(this._wsUrl);
      const subscribeReqId = this._nextReqId++;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        try {
          ws.removeAllListeners();
          ws.close();
        } catch {}
        reject(err);
      };

      ws.on('open', () => {
        const payload = {
          req_id: subscribeReqId,
          type: 'dataref_subscribe_values',
          params: {
            datarefs: this._resolvedSpecs.map((spec) => {
              const dataref: { id: number; index?: number[] } = { id: spec.id };
              if (typeof spec.index !== 'undefined') dataref.index = spec.index;
              return dataref;
            }),
          },
        };

        try {
          ws.send(JSON.stringify(payload));
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      });

      ws.on('message', (raw) => {
        let message: AnyRecord;
        try {
          message = JSON.parse(raw.toString());
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          if (!settled) fail(new Error(`Invalid WS message: ${errorMessage}`));
          return;
        }

        if (message?.type === 'result' && message?.req_id === subscribeReqId) {
          if (message.success === false) {
            fail(new Error(message.error_message || message.error_code || 'Subscription failed'));
            return;
          }

          this._ws = ws;
          this._connected = true;
          this._available = true;

          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        if (message?.type === 'dataref_update_values') {
          this._applyUpdate(message.data);
        }
      });

      ws.on('error', (err) => {
        if (!settled) {
          fail(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.warn(`[XPlaneTelemetry] WebSocket error: ${errorMessage}`);
      });

      ws.on('close', () => {
        this._ws = null;
        this._resetConnectionState();
        if (!settled) {
          fail(new Error('WebSocket closed before subscription completed'));
          return;
        }
        if (!this._stopped) {
          this._scheduleReconnect();
        }
      });
    });
  }

  _applyUpdate(data: Record<string, unknown> | null | undefined): void {
    if (!data || typeof data !== 'object') return;

    for (const spec of this._resolvedSpecs) {
      const rawValue = data[String(spec.id)];
      if (typeof rawValue === 'undefined') continue;
      this._data[spec.key] = spec.stringData ? decodeStringDataValue(rawValue) : rawValue;
    }
  }

  _resetConnectionState(): void {
    this._connected = false;
    this._available = false;
    this._resolvedSpecs = [];
    this._data = Object.create(null);
  }
}

module.exports = { XPlaneTelemetryProvider };

export {};
