import { defineStore } from 'pinia';
import { buildLandingPresentation } from '../../landing/scoring.js';

const DEFAULT_GRADE_COLOR = '#4a5e74';
const RA_DISPLAY_THRESHOLD = 2500;
const LBS_TO_KG = 0.453592;

function formatNumber(value, fallback = '--') {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.round(numericValue).toLocaleString() : fallback;
}

function formatSignedNumber(value, fallback = '--') {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  const rounded = Math.round(numericValue);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function toneForRange(value, warningLimit, dangerLimit, absolute = false) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  const comparedValue = absolute ? Math.abs(numericValue) : numericValue;
  if (comparedValue > dangerLimit) return 'danger';
  if (comparedValue > warningLimit) return 'warning';
  return null;
}

function descentTone(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  if (numericValue < -1000) return 'danger';
  if (numericValue < -500) return 'warning';
  return null;
}

function formatFuelValue(totalGal, totalWeightLbs, unit) {
  const numericGallons = typeof totalGal === 'number' && Number.isFinite(totalGal) ? totalGal : null;
  const numericWeightLbs = typeof totalWeightLbs === 'number' && Number.isFinite(totalWeightLbs)
    ? totalWeightLbs
    : null;
  if (unit === 'lbs') {
    return numericWeightLbs != null ? Math.round(numericWeightLbs).toLocaleString() : '----';
  }
  if (unit === 'kg') {
    return numericWeightLbs != null
      ? Math.round(numericWeightLbs * LBS_TO_KG).toLocaleString()
      : '----';
  }
  return numericGallons != null ? Math.round(numericGallons).toLocaleString() : '----';
}

function formatDecimalNumber(value, digits = 2, fallback = '--') {
  if (value == null || value === '') return fallback;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(digits) : fallback;
}

function formatOptionalNumber(value, fallback = '--') {
  if (value == null || value === '') return fallback;
  return formatNumber(value, fallback);
}

function getDefaultTelemetry() {
  return {
    ias: '---',
    gs: '---',
    vs: '----',
    alt: '-----',
    ra: '----',
    raVisible: true,
    altitudeDiagnostics: {
      indicated: '-----',
      calibrated: '-----',
      plane: '-----',
      pressure: '-----',
      radio: '----',
      aircraftAgl: '----',
      aircraftAboveObstacles: '----',
      planeAgl: '----',
      planeAglMinusCg: '----',
      kohlsmanSettingMb: '----.--',
      kohlsmanTunedMb: '----.--',
      kohlsmanStd: '--',
    },
    hdg: '---',
    xwind: '--',
    xwindArrow: '\u2190',
    xwindArrowOpacity: '0.5',
    fuel: '----',
    fuelUnit: 'gal',
    fuelTotalGal: null,
    fuelTotalWeightLbs: null,
    gearState: 'UP',
    gear: {
      nose: null,
      left: null,
      right: null,
      parkingBrake: false,
    },
    flaps: 'UP',
    flapsUnit: '',
    spoilers: 'STOWED',
    engines: {
      count: 2,
      values: ['--', '--', '--', '--'],
    },
    cabinAlt: '----',
    cabinVs: '----',
    oat: '--',
    lights: {
      available: true,
      nav: false,
      beacon: false,
      strobe: false,
      landing: false,
      taxi: false,
    },
    quickGlance: {
      ias: '---',
      vs: '----',
      ra: '---',
    },
    tones: {
      vs: null,
      ra: null,
      xwind: null,
      fuel: null,
      cabinAlt: null,
      cabinVs: null,
    },
  };
}

function getDefaultWarnings() {
  return {
    speed: {
      active: false,
      label: '',
    },
    fuelExhausted: {
      visible: false,
    },
    cabinAltitude: {
      active: false,
      severity: '',
      bannerVisible: false,
      label: '',
    },
  };
}

function gearDotState(value) {
  if (value >= 0.99) return 'down';
  if (value > 0.05) return 'transit';
  return '';
}

function normalizeGearState(value) {
  const state = String(value || '').trim().toUpperCase();
  if (state === 'DOWN' || state === 'UP' || state === 'TRANSIT') return state;
  if (state === 'TRANS') return 'TRANSIT';
  return null;
}

function resolveGearState(data) {
  const backendState = normalizeGearState(data?.gearState);
  if (backendState) return backendState;
  if (data?.locked === true) return 'DOWN';

  const left = Number(data?.left);
  const right = Number(data?.right);
  const nose = Number(data?.nose);
  const hasLeft = Number.isFinite(left);
  const hasRight = Number.isFinite(right);
  const hasNose = data?.nose == null || Number.isFinite(nose);
  const noseDown = data?.nose == null || nose >= 0.99;
  const noseUp = data?.nose == null || nose <= 0.05;
  const allDown = hasLeft && hasRight && hasNose && left >= 0.99 && right >= 0.99 && noseDown;
  const allUp = hasLeft && hasRight && hasNose && left <= 0.05 && right <= 0.05 && noseUp;
  return allDown ? 'DOWN' : allUp ? 'UP' : 'TRANSIT';
}

function resolveGearDotValue(data, position, state) {
  if (state === 'DOWN') return 1;
  if (state === 'UP') return 0;
  const value = Number(data?.[position]);
  return Number.isFinite(value) ? value : 0;
}

const FLIGHT_STATES = Object.freeze({
  connecting: {
    title: 'Connecting to telemetry',
    copy: 'Waiting for the backend and simulator to start streaming live flight data.',
    hidden: true,
    muted: true,
  },
  waiting: {
    title: 'Waiting for live telemetry',
    copy: 'Connected to the backend. Start or resume a flight to populate the live aircraft panels.',
    hidden: true,
    muted: true,
  },
  disconnected: {
    title: 'Telemetry disconnected',
    copy: 'The live feed is offline right now. We will keep trying to reconnect automatically.',
    hidden: true,
    muted: true,
  },
  error: {
    title: 'Connection failed',
    copy: 'The UI could not establish a live telemetry session yet. Check the backend and simulator, then try again.',
    hidden: true,
    muted: true,
  },
  inMenu: {
    title: 'Simulator is in menus',
    copy: 'Live flight data is paused until the simulator returns to an active flight session.',
    hidden: true,
    muted: true,
  },
  live: {
    title: '',
    copy: '',
    hidden: true,
    muted: false,
  },
});

function resolveFlightState(mode, overrides = {}) {
  return {
    ...(FLIGHT_STATES[mode] || FLIGHT_STATES.waiting),
    ...overrides,
  };
}

function getDefaultLandingPreview() {
  return {
    available: false,
    status: 'Waiting for touchdown in this session.',
    grade: '--',
    vs: '--',
    runway: '--',
    stability: '--',
    stabilityScore: '',
    stabilityTone: 'text-gray-400',
    bounce: '--',
    bounceDetail: '',
    bounceTone: 'text-gray-400',
    tdz: '--',
    tdzDetail: '',
    tdzTone: 'text-gray-400',
    color: DEFAULT_GRADE_COLOR,
  };
}

export const useFlightStore = defineStore('flight', {
  state: () => {
    const initialFlightState = resolveFlightState('connecting');
    return {
      mode: 'connecting',
      title: initialFlightState.title,
      copy: initialFlightState.copy,
      panelHidden: initialFlightState.hidden === true,
      muted: initialFlightState.muted !== false,
      lastLanding: getDefaultLandingPreview(),
      telemetry: getDefaultTelemetry(),
      warnings: getDefaultWarnings(),
    };
  },

  getters: {
    flightStateVisible: (state) => state.panelHidden !== true,
    valueToneClass: (state) => (key) => {
      const tone = state.telemetry.tones[key];
      return tone ? `text-${tone}` : '';
    },
    xwindArrowStyle: (state) => ({
      minWidth: '24px',
      textAlign: 'center',
      opacity: state.telemetry.xwindArrowOpacity,
    }),
    engineCards: (state) => state.telemetry.engines.values.map((value, index) => ({
      number: index + 1,
      value,
      visible: index < state.telemetry.engines.count,
    })),
    gearDotClass: (state) => (position) => {
      const dotState = gearDotState(state.telemetry.gear[position]);
      return dotState ? `gear-dot lg:w-4 lg:h-4 ${dotState}` : 'gear-dot lg:w-4 lg:h-4';
    },
    quickGlanceGearDotClass: (state) => (position) => {
      const dotState = gearDotState(state.telemetry.gear[position]);
      return dotState ? `qg-gear-dot ${dotState}` : 'qg-gear-dot';
    },
    parkingBrakeClass: (state) => `brake-indicator ${state.telemetry.gear.parkingBrake === true ? 'set' : 'off'} lg:text-sm lg:px-3 lg:py-1`,
    lightClass: (state) => (name) => `light-indicator${state.telemetry.lights[name] ? ' on' : ''}`,
    speedWarningVisible: (state) => state.warnings.speed.active === true,
    speedWarningLabel: (state) => state.warnings.speed.label || '',
    fuelExhaustedWarningVisible: (state) => state.warnings.fuelExhausted.visible === true,
    cabinAltitudeBannerVisible: (state) => state.warnings.cabinAltitude.bannerVisible === true,
    cabinAltitudeBannerLabel: (state) => state.warnings.cabinAltitude.label || 'CABIN ALT ? FT',
    cabinAltCardToneClass: (state) => {
      if (state.warnings.cabinAltitude.active && state.warnings.cabinAltitude.severity === 'critical') {
        return 'border-red-500';
      }
      if (state.warnings.cabinAltitude.active && state.warnings.cabinAltitude.severity === 'warning') {
        return 'border-amber-500';
      }
      return 'border-surface-200';
    },
  },

  actions: {
    setFlightState(mode, overrides = {}) {
      const next = resolveFlightState(mode, overrides);
      this.mode = mode || 'waiting';
      this.title = next.title || '';
      this.copy = next.copy || '';
      this.panelHidden = next.hidden === true;
      this.muted = next.muted !== false;
      return next;
    },

    resetLiveTelemetry() {
      const fuelUnit = this.telemetry.fuelUnit || 'gal';
      this.telemetry = getDefaultTelemetry();
      this.warnings = getDefaultWarnings();
      this.telemetry.fuelUnit = fuelUnit;
      this.telemetry.raVisible = false;
      this.telemetry.xwindArrow = '\u2014';
      this.telemetry.xwindArrowOpacity = '0.3';
    },

    updateSpeedDisplay({ ias = null, gs = null } = {}) {
      if (ias != null) {
        const roundedIas = Math.round(Number(ias));
        if (Number.isFinite(roundedIas)) {
          this.telemetry.ias = String(roundedIas);
          this.telemetry.quickGlance.ias = String(roundedIas);
        }
      }

      if (gs != null) {
        this.telemetry.gs = formatNumber(gs, '---');
      }
    },

    updateVerticalSpeedDisplay(vsRaw) {
      this.telemetry.vs = formatSignedNumber(vsRaw, '----');
      this.telemetry.quickGlance.vs = this.telemetry.vs;
      this.telemetry.tones.vs = descentTone(vsRaw);
    },

    updateAltitudeDisplay({
      msl = null,
      indicated = null,
      calibrated = null,
      plane = null,
      ra = null,
      aircraftAgl = null,
      aircraftAboveObstacles = null,
      planeAgl = null,
      planeAglMinusCg = null,
      pressureAlt = null,
      kohlsmanSettingMb = null,
      kohlsmanTunedMb = null,
      kohlsmanStd = null,
    } = {}) {
      if (msl != null) {
        this.telemetry.alt = formatNumber(msl, '-----');
      }

      const diagnostics = this.telemetry.altitudeDiagnostics;
      const indicatedValue = indicated ?? msl;
      // Altitude messages are snapshots. Clear an optional channel as soon as
      // the backend reports it unavailable so switching aircraft/providers
      // cannot leave a plausible-looking value from the previous source.
      diagnostics.indicated = formatOptionalNumber(indicatedValue, '-----');
      diagnostics.calibrated = formatOptionalNumber(calibrated, '-----');
      diagnostics.plane = formatOptionalNumber(plane, '-----');
      diagnostics.pressure = formatOptionalNumber(pressureAlt, '-----');
      diagnostics.radio = formatOptionalNumber(ra, '----');
      diagnostics.aircraftAgl = formatOptionalNumber(aircraftAgl, '----');
      diagnostics.aircraftAboveObstacles = formatOptionalNumber(aircraftAboveObstacles, '----');
      diagnostics.planeAgl = formatOptionalNumber(planeAgl, '----');
      diagnostics.planeAglMinusCg = formatOptionalNumber(planeAglMinusCg, '----');
      diagnostics.kohlsmanSettingMb = formatDecimalNumber(kohlsmanSettingMb, 2, '----.--');
      diagnostics.kohlsmanTunedMb = formatDecimalNumber(kohlsmanTunedMb, 2, '----.--');
      diagnostics.kohlsmanStd = typeof kohlsmanStd === 'boolean'
        ? (kohlsmanStd ? 'STD' : 'QNH')
        : '--';

      const numericRa = Number(ra);
      if (ra != null && Number.isFinite(numericRa) && numericRa < RA_DISPLAY_THRESHOLD) {
        this.telemetry.ra = formatNumber(numericRa, '----');
        this.telemetry.quickGlance.ra = String(Math.round(numericRa));
        this.telemetry.tones.ra = numericRa < 200 ? 'warning' : null;
        this.telemetry.raVisible = true;
        return;
      }

      this.telemetry.quickGlance.ra = '---';
      this.telemetry.raVisible = false;
    },

    updateHeadingDisplay(message = {}) {
      const heading = Math.round(Number(message.mag ?? message.true ?? 0));
      this.telemetry.hdg = Number.isFinite(heading) ? String(heading).padStart(3, '0') : '---';
    },

    updateCrosswindDisplay(value) {
      const numericValue = typeof value === 'number' && Number.isFinite(value) ? value : null;
      if (numericValue == null) {
        this.telemetry.xwind = '--';
        this.telemetry.tones.xwind = null;
        this.telemetry.xwindArrow = '\u2014';
        this.telemetry.xwindArrowOpacity = '0.3';
        return;
      }
      const rounded = Math.abs(Math.round(numericValue));
      this.telemetry.xwind = Number.isFinite(rounded) ? String(rounded) : '--';
      this.telemetry.tones.xwind = Number.isFinite(rounded)
        ? (rounded > 15 ? 'danger' : rounded > 10 ? 'warning' : null)
        : null;

      if (!Number.isFinite(numericValue) || numericValue === 0) {
        this.telemetry.xwindArrow = '\u2014';
        this.telemetry.xwindArrowOpacity = '0.3';
        return;
      }

      this.telemetry.xwindArrow = numericValue > 0 ? '\u2190' : '\u2192';
      this.telemetry.xwindArrowOpacity = '0.8';
    },

    updateFuelDisplay({ displayValue = null, unit = 'gal', totalGal = null, totalWeightLbs = null } = {}) {
      this.telemetry.fuel = displayValue != null ? String(displayValue) : '----';
      this.telemetry.fuelUnit = unit || 'gal';
      this.telemetry.fuelTotalGal = typeof totalGal === 'number' && Number.isFinite(totalGal) ? totalGal : null;
      this.telemetry.fuelTotalWeightLbs = typeof totalWeightLbs === 'number' && Number.isFinite(totalWeightLbs)
        ? totalWeightLbs
        : null;
      const numericFuel = typeof totalGal === 'number' && Number.isFinite(totalGal) ? totalGal : null;
      if (numericFuel == null) {
        this.telemetry.tones.fuel = null;
      } else if (numericFuel < 100) {
        this.telemetry.tones.fuel = 'danger';
      } else if (numericFuel < 500) {
        this.telemetry.tones.fuel = 'warning';
      } else {
        this.telemetry.tones.fuel = null;
      }
    },

    ingestMessage(message) {
      if (!message || typeof message !== 'object') return;

      switch (message.type) {
        case 'ias':
          this.updateSpeedDisplay({ ias: message.value });
          break;
        case 'gs':
          this.updateSpeedDisplay({ gs: message.value });
          break;
        case 'vs':
          this.updateVerticalSpeedDisplay(message.value);
          break;
        case 'altitude':
          this.updateAltitudeDisplay(message);
          break;
        case 'heading':
          this.updateHeadingDisplay(message);
          break;
        case 'xwind':
          this.updateCrosswindDisplay(message.value);
          break;
        case 'fuel': {
          const unit = this.telemetry.fuelUnit || 'gal';
          this.updateFuelDisplay({
            displayValue: message.displayValue ?? formatFuelValue(message.totalGal, message.totalWeightLbs, unit),
            unit: message.unit || unit,
            totalGal: message.totalGal,
            totalWeightLbs: message.totalWeightLbs,
          });
          break;
        }
        case 'gear':
          this.updateGear(message.data);
          break;
        case 'lights':
          this.updateLights(message.data);
          break;
        case 'flaps':
          this.updateFlaps(message);
          break;
        case 'spoilers':
          this.updateSpoilers(message.value);
          break;
        case 'engines':
          this.updateEngineDisplay(message.data);
          break;
        case 'environment':
          this.updateEnvironment(message);
          break;
        case 'overspeed':
        case 'stall':
          this.updateSpeedWarning(message);
          break;
        case 'fuelExhausted':
          this.showFuelExhaustedWarning(message);
          break;
        case 'cabinAltitudeWarning':
          this.updateCabinAltitudeWarning(message);
          break;
        case 'aircraftChanged':
          this.resetLiveTelemetry();
          break;
      }
    },

    updateGear(data) {
      if (!data) return;
      const state = resolveGearState(data);
      this.telemetry.gearState = state;
      this.telemetry.gear = {
        nose: resolveGearDotValue(data, 'nose', state),
        left: resolveGearDotValue(data, 'left', state),
        right: resolveGearDotValue(data, 'right', state),
        locked: data.locked === true,
        parkingBrake: data.parkingBrake === true,
      };
    },

    updateLights(data) {
      if (!data) return;
      this.telemetry.lights = {
        available: data.available !== false,
        nav: data.available !== false && data.nav === true,
        beacon: data.available !== false && data.beacon === true,
        strobe: data.available !== false && data.strobe === true,
        landing: data.available !== false && data.landing === true,
        taxi: data.available !== false && data.taxi === true,
      };
    },

    updateFlaps(message = {}) {
      const flapsValue = message.value;
      if (flapsValue?.notch != null && flapsValue.notch !== flapsValue.percent) {
        const label = flapsValue.label || flapsValue.notch;
        this.telemetry.flaps = label === 0 || label === '0' ? 'UP' : String(label);
        this.telemetry.flapsUnit = '';
        return;
      }

      const percent = flapsValue?.percent ?? (flapsValue?.fraction * 100) ?? 0;
      this.telemetry.flaps = percent < 1 ? 'UP' : String(Math.round(percent));
      this.telemetry.flapsUnit = percent >= 1 ? '%' : '';
    },

    updateSpoilers(value) {
      this.telemetry.spoilers = value?.state != null ? String(value.state) : 'N/A';
    },

    updateEngineDisplay(data) {
      if (!data) return;
      const count = Number(data.count || 2);
      this.telemetry.engines.count = Number.isFinite(count) ? Math.max(1, Math.min(4, count)) : 2;
      this.telemetry.engines.values = [1, 2, 3, 4].map((engineNumber) => {
        const value = data[`eng${engineNumber}Text`] || data[`eng${engineNumber}`];
        return value != null ? String(value) : '--';
      });
    },

    updateEnvironment(message = {}) {
      const cabinAlt = Number(message.cabinAltFt);
      if (Number.isFinite(cabinAlt)) {
        this.telemetry.cabinAlt = Math.round(cabinAlt).toLocaleString();
        this.telemetry.tones.cabinAlt = toneForRange(cabinAlt, 10000, 14000);
      } else {
        this.telemetry.cabinAlt = '----';
        this.telemetry.tones.cabinAlt = null;
      }

      const cabinVs = Number(message.cabinAltRateFpm);
      if (Number.isFinite(cabinVs)) {
        this.telemetry.cabinVs = formatSignedNumber(cabinVs, '----');
        this.telemetry.tones.cabinVs = toneForRange(cabinVs, 500, 1000, true);
      } else {
        this.telemetry.cabinVs = '----';
        this.telemetry.tones.cabinVs = null;
      }

      this.telemetry.oat = message.oatC != null ? String(message.oatC) : '--';
    },

    updateSpeedWarning({ type = '', active = false, overspeedType = '' } = {}) {
      if (active !== true) {
        this.warnings.speed = getDefaultWarnings().speed;
        return;
      }

      const label = type === 'overspeed'
        ? (overspeedType === 'vfe' ? 'FLAP OVERSPEED' : 'OVERSPEED')
        : 'STALL';

      this.warnings.speed = {
        active: true,
        label,
      };
    },

    showFuelExhaustedWarning(message = {}) {
      if (message.exhausted !== true) return;
      this.warnings.fuelExhausted.visible = true;
    },

    hideFuelExhaustedWarning() {
      this.warnings.fuelExhausted.visible = false;
    },

    updateCabinAltitudeWarning(message = {}) {
      if (message.active !== true) {
        this.warnings.cabinAltitude = getDefaultWarnings().cabinAltitude;
        return;
      }

      const severity = message.severity || '';
      const cabinAltFt = Number(message.cabinAltFt);
      this.warnings.cabinAltitude = {
        active: true,
        severity,
        bannerVisible: severity === 'critical',
        label: `CABIN ALT ${Number.isFinite(cabinAltFt) ? cabinAltFt.toLocaleString() : '?'} FT`,
      };
    },

    hideCabinAltitudeBanner() {
      this.warnings.cabinAltitude.bannerVisible = false;
    },

    resetLandingPreview() {
      this.lastLanding = getDefaultLandingPreview();
    },

    updateLandingPreview(rawLanding) {
      if (!rawLanding) return null;
      const presentation = buildLandingPresentation(rawLanding);
      const normalized = presentation.verdict.normalized;
      const vs = Number(rawLanding.vs);
      const baseStatus = rawLanding.final
        ? 'Latest touchdown report is ready.'
        : 'Preview from selected Logbook timeline event.';
      const stabilityText = presentation.approachVerdict
        || (presentation.stabilityScore != null ? 'NO VERDICT' : '--');
      const touchdownDistance = rawLanding.touchdownDistance;
      const touchdownDistanceFt = Number(touchdownDistance?.distanceFt);
      const hasTouchdownDistance = touchdownDistance?.distanceFt != null
        && Number.isFinite(touchdownDistanceFt);

      this.lastLanding = {
        available: true,
        status: baseStatus,
        grade: presentation.touchdownGrade,
        vs: Number.isFinite(vs) ? `${Math.round(vs)} fpm` : '--',
        runway: rawLanding.icao && rawLanding.runway
          ? `${rawLanding.icao} ${rawLanding.runway}`
          : (rawLanding.icao || '--'),
        stability: stabilityText,
        stabilityScore: presentation.approachScoreText || '',
        stabilityTone: presentation.stabilityVerdict === 'unstable'
          ? 'text-red-400'
          : presentation.stabilityVerdict === 'marginal'
            ? 'text-amber-400'
            : presentation.stabilityVerdict === 'stable'
              ? 'text-green-400'
              : 'text-gray-400',
        bounce: presentation.bounceText || '--',
        bounceDetail: presentation.bounceKnown
          ? (presentation.verdict.bounce.bounceGrade || '')
          : '',
        bounceTone: !presentation.bounceKnown
          ? 'text-gray-400'
          : presentation.bounceCount === 0
            ? 'text-green-400'
            : presentation.verdict.bounce.severity >= 3
              ? 'text-red-400'
              : 'text-amber-400',
        tdz: hasTouchdownDistance
          ? `${Math.round(touchdownDistanceFt)} ft`
          : (touchdownDistance?.grade || '--'),
        tdzDetail: [
          hasTouchdownDistance ? touchdownDistance?.grade : null,
          presentation.verdict.flags.runwayExcursion ? 'Runway excursion' : null,
        ].filter(Boolean).join(' · '),
        tdzTone: presentation.verdict.touchdown.textClass || 'text-gray-400',
        color: presentation.touchdownColor || DEFAULT_GRADE_COLOR,
      };

      return normalized;
    },
  },
});
