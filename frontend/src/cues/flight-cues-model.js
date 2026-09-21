import { presetObservation, presetSourceUnavailableReason } from '../aircraft/preset-observation.js';
import { getAircraftControlCanonicalCommandId } from '../aircraft/control-ui.js';
import { answerAircraftStateQuery, efisFieldId, freshAircraftValue } from '../voice/state-queries.js';
import { aircraftFlightCue } from './aircraft-cue-policies.js';
import { observedCueConfiguration } from './aircraft-cue-observations.js';

const LIVE_MAX_AGE_MS = 6000;
const normalizePhase = phase => String(phase || '').trim().toUpperCase().replaceAll('_', '-');

function recent(timestamp, now) {
  return Number.isFinite(timestamp) && timestamp - now <= 1000 && now - timestamp <= LIVE_MAX_AGE_MS;
}
const recentReadback = (telemetry, field, now) => recent(telemetry?.observedAt?.[field], now);

export function isFlightCueDataLive({ status, flight, now = Date.now() }) {
  return status?.websocket === 'ready' && status?.simConnected === true && status?.simInMenu !== true
    && flight?.mode === 'live' && recent(flight?.lastLiveTelemetryAt, now);
}

// Phase context is not a claim that a checklist has been completed.
const PHASE_BRIEFS = Object.freeze({
  PARKED: { title: 'At the stand', detail: 'Review aircraft power and your departure plan. Before moving, confirm the route, initial clearance and aircraft setup.' },
  TAXI: { title: 'Before the runway', detail: 'Review the departure and takeoff configuration while taxiing. Have the takeoff lights ready for runway entry.' },
  TAKEOFF: { title: 'Takeoff underway', detail: 'Keep your attention on the takeoff and initial flight path. Configuration reminders return in the climb.' },
  CLIMB: { title: 'Climb and clean up', detail: 'Check the gear and follow the aircraft’s flap retraction schedule. Confirm the selected altitude against your clearance.' },
  CRUISE: { title: 'Cruise check-in', detail: 'Review fuel against the plan, progress along the route and arrival weather. Brief the descent before reaching it.' },
  DESCENT: { title: 'Prepare the approach', detail: 'Review the arrival, approach and missed approach. Check the required frequencies, course, altimeter setting and minimums before the busy part.' },
  APPROACH: { title: 'Approach configuration', detail: 'Follow the aircraft’s speed and configuration schedule. Check the gear, landing flaps and landing checklist before the final segment.' },
  LANDING: { title: 'Landing underway', detail: 'Keep your attention on the landing and rollout. Leave after-landing configuration changes until clear of the runway.' },
  'GO-AROUND': { title: 'Go-around', detail: 'Follow the aircraft’s go-around procedure and missed-approach clearance. Confirm flight guidance and the next altitude; resume configuration changes on the aircraft’s schedule.' },
  'TAXI-IN': { title: 'After landing', detail: 'Once clear of the runway, complete the after-landing checks and review the taxi route. Plan the power source you will need at the stand.' },
});

export function flightPhaseBrief(phase, { arrived = false } = {}) {
  if (normalizePhase(phase) === 'PARKED' && arrived) {
    return { title: 'At the stand after landing', detail: 'Secure the aircraft and confirm the required ground or auxiliary power before shutdown. Your flight review is in Logbook.' };
  }
  return PHASE_BRIEFS[normalizePhase(phase)] || {
    title: 'Waiting for the flight phase', detail: 'Flight guidance will appear when the simulator reports a flight phase.',
  };
}

const action = (id, title, detail, extra = {}) => ({ id, title, detail, ...extra });
const lightIs = (name, value) => (t, now) => recentReadback(t, 'lights', now)
  && t.lights?.available === true && t.lights[name] === value;
const gearIs = value => (t, now) => recentReadback(t, 'gear', now) && t.gearState === value;
const flapsExtended = (t, now) => recentReadback(t, 'flaps', now) && t.flapsExtended === true;
const altitudeCue = action('flightGuidance.altitude.set', 'Your next cleared altitude',
  'When a new altitude is cleared, set the selected altitude and verify it in the cockpit. This sets the target; it does not select a climb or descent mode.',
  { placeholder: 'cleared altitude in feet', inputKind: 'number' });
const flapCue = action('surfaces.flaps.set', 'Follow the flap schedule',
  'Flaps read extended. At the appropriate speed, select the next detent in your aircraft’s retraction schedule.',
  { placeholder: 'next detent', inputKind: 'enum', when: flapsExtended });
const apuCue = action('configuration.apu.start', 'Auxiliary power, if needed',
  'If you need APU power, use this aircraft’s startup preset after checking its power requirements. Confirm availability in the cockpit before transferring loads.',
  { kind: 'preset' });
const landingSystemCues = ['captain', 'firstOfficer'].map(side => {
  const label = side === 'captain' ? 'captain' : 'first officer';
  return action(`navigation.${side}.ls`, 'Approach display',
    `For an approach that uses the landing-system display, enable ${label} LS and verify the required indications. This changes the display only; it does not arm LOC or APPR.`,
    { value: 'on', whenAircraft: (snapshot, catalogue, now) => {
      const field = efisFieldId(catalogue.profileKey, side, 'ls');
      return field != null && freshAircraftValue(snapshot, field, now) === false;
    } });
});

// Bracketed values teach commands without inventing clearances, flap schedules,
// frequencies or aircraft-specific targets.
const CUES_BY_PHASE = Object.freeze({
  PARKED: [
    action('surfaces.parkingBrake.set', 'While stationary', 'The parking brake reads released. If the aircraft should be secured here, set it and check the indication.',
      { value: 'on', when: (t, now) => recentReadback(t, 'gear', now) && t.gear?.parkingBrake === false }),
    apuCue,
    action('surveillance.squawk.set', 'Departure clearance', 'Once assigned a transponder code, enter it and check the cockpit indication.',
      { placeholder: 'assigned code', inputKind: 'number', departureOnly: true }),
    { ...altitudeCue, departureOnly: true },
  ],
  TAXI: [
    action('configuration.lights.takeoff', 'Before takeoff', 'At runway entry, when appropriate, use this aircraft’s takeoff-light preset. Keep this ready before the takeoff roll.', { kind: 'preset' }),
    action('lights.landing.set', 'Before takeoff', 'At runway entry, switch on the landing lights when appropriate.', { value: 'on', when: lightIs('landing', false), fallbackFor: 'configuration.lights.takeoff' }),
    action('lights.taxi.set', 'Taxi lighting', 'The taxi lights read off. Switch them on if needed for your taxi.', { value: 'on', when: lightIs('taxi', false), fallbackFor: 'configuration.lights.takeoff' }),
    action('surfaces.flaps.set', 'Takeoff configuration', 'Check the planned takeoff flap setting before reaching the runway. Use the setting from your aircraft’s takeoff plan.',
      { placeholder: 'planned takeoff detent', inputKind: 'enum' }),
    action('surfaces.flaps.adjust', 'Takeoff configuration', 'The flaps read retracted. If your takeoff plan calls for flap extension, move one detent at a time and verify the planned setting before the runway.',
      { value: 'increase', fallbackFor: 'surfaces.flaps.set', when: (t, now) => recentReadback(t, 'flaps', now) && t.flapsExtended === false }),
    action('surfaces.autobrake.set', 'Before takeoff', 'If required by your aircraft’s departure procedure, select the rejected-takeoff autobrake setting and verify it.', { value: 'rto' }),
  ],
  CLIMB: [
    action('surfaces.gear.set', 'After liftoff', 'The gear reads down. Once a positive climb is confirmed, retract it according to your aircraft’s procedure.', { value: 'up', when: gearIs('DOWN') }),
    action('configuration.lights.afterTakeoff', 'Climb-out lighting', 'The landing lights read on. At the altitude your procedure uses, apply this aircraft’s after-takeoff light preset. Strobes stay on.',
      { kind: 'preset', when: lightIs('landing', true) }),
    action('lights.landing.set', 'Climb-out lighting', 'The landing lights read on. Switch them off at the altitude your procedure uses.',
      { value: 'off', when: lightIs('landing', true), fallbackFor: 'configuration.lights.afterTakeoff' }),
    flapCue,
    action('surfaces.flaps.adjust', 'Follow the flap schedule', 'Flaps read extended. At the appropriate speed, retract one detent and check the result.',
      { value: 'decrease', when: flapsExtended, fallbackFor: 'surfaces.flaps.set' }),
    altitudeCue,
  ],
  CRUISE: [
    { query: 'what is selected altitude', title: 'Check the selected altitude', detail: 'You can ask for the selected altitude while reviewing your clearance. Compare the answer with the cockpit and your flight plan.' },
    action('radios.com1.setStandby', 'Prepare the next frequency', 'When the next frequency is known, prepare COM 1 standby. Check it before switching over.',
      { placeholder: 'next frequency', inputKind: 'number' }),
  ],
  DESCENT: [
    action('flightGuidance.course.setBoth', 'Approach course', 'For an approach that uses the course windows, set the published course and check both windows.',
      { placeholder: 'approach course', inputKind: 'number', kind: 'preset' }),
    action('radios.nav.setBothActive', 'Approach frequency', 'If the approach calls for both NAV receivers on the same frequency, tune and verify them before intercept.',
      { placeholder: 'approach frequency', inputKind: 'number', kind: 'preset' }),
    action('radios.nav1.setStandby', 'Prepare the approach radio', 'If a NAV frequency is needed for the approach, tune standby and verify it before making it active.',
      { placeholder: 'approach frequency', inputKind: 'number', fallbackFor: 'radios.nav.setBothActive' }),
    action('baro.both.qnhHpa', 'Arrival altimeter setting', 'When local pressure is required, use the current reported QNH and verify the altimeters.',
      { placeholder: 'reported QNH in hPa', inputKind: 'number' }),
    action('approach.captain.minimumsMode', 'Minimums reference', 'Check whether the approach uses barometric or radio minimums. This changes the reference only; enter and verify the numeric minimums in the cockpit.',
      { placeholder: 'minimums reference', inputKind: 'enum' }),
    ...landingSystemCues,
    altitudeCue,
  ],
  APPROACH: [
    action('surfaces.gear.set', 'Landing configuration', 'The gear reads up. Lower it at the appropriate point in your aircraft’s approach sequence, within its operating limits.', { value: 'down', when: gearIs('UP') }),
    action('surfaces.flaps.set', 'Landing flap setting', 'As speed permits, select the next planned approach detent. Use your aircraft’s schedule and planned landing setting.',
      { placeholder: 'planned approach detent', inputKind: 'enum' }),
    action('surfaces.flaps.adjust', 'Landing flap setting', 'If the next planned setting calls for more flap, extend one detent at the appropriate speed and check the indication. Follow the aircraft’s schedule.',
      { value: 'increase', fallbackFor: 'surfaces.flaps.set', when: (t, now) => recentReadback(t, 'flaps', now) && typeof t.flapsExtended === 'boolean' }),
    action('surfaces.spoilersArmed.set', 'Landing checklist', 'Ground spoilers read disarmed. If required for this landing, arm them at the appropriate point in the landing checklist and verify the indication.',
      { value: 'on', whenConfiguration: observed => observed.spoilers === false }),
    { query: 'are spoilers armed', title: 'Landing checklist', detail: 'If ground spoilers are required for this landing, ask for their current indication and verify it in the cockpit.', fallbackFor: 'surfaces.spoilersArmed.set' },
    action('surfaces.autobrake.set', 'Landing braking plan', 'Use the planned landing autobrake setting for this aircraft and runway, then check its indication.',
      { placeholder: 'planned landing setting', inputKind: 'enum', excludeValues: ['rto'] }),
    action('configuration.lights.landing', 'Landing lighting', 'The landing lights read off. When appropriate for the approach, apply this aircraft’s landing-light preset.',
      { kind: 'preset', when: lightIs('landing', false) }),
    action('lights.landing.set', 'Landing lighting', 'The landing lights read off. Switch them on when appropriate for the approach.',
      { value: 'on', when: lightIs('landing', false), fallbackFor: 'configuration.lights.landing' }),
  ],
  'TAXI-IN': [
    action('configuration.lights.afterLanding', 'After clearing the runway', 'The landing lights read on. Once clear of the runway, apply this aircraft’s after-landing light preset.',
      { kind: 'preset', when: lightIs('landing', true) }),
    action('lights.landing.set', 'After clearing the runway', 'Once clear of the runway, switch off the landing lights when appropriate.',
      { value: 'off', when: lightIs('landing', true), fallbackFor: 'configuration.lights.afterLanding' }),
    action('lights.taxi.set', 'Taxi to the stand', 'The taxi lights read off. Switch them on if needed for the taxi to your stand.',
      { value: 'on', when: lightIs('taxi', false), fallbackFor: 'configuration.lights.afterLanding' }),
    action('surfaces.flaps.set', 'After clearing the runway', 'Once clear of the runway, carry out the after-landing flap procedure for this aircraft.',
      { placeholder: 'after-landing detent', inputKind: 'enum', when: flapsExtended }),
    action('surfaces.flaps.adjust', 'After clearing the runway', 'Once clear of the runway, retract one detent at a time as your aircraft’s after-landing procedure calls for it. Check the indication.',
      { value: 'decrease', fallbackFor: 'surfaces.flaps.set', when: flapsExtended }),
    apuCue,
  ],
});

function speechFor(command, cue, observed, phase) {
  const input = command.input || {};
  const patterns = command.speech?.patterns;
  if (!Array.isArray(patterns)) return null;
  let choices = input.kind === 'enum' && Array.isArray(input.values)
    ? input.values.filter(v => (!cue.includeValues || cue.includeValues.includes(v)) && !cue.excludeValues?.includes(v)) : null;
  // The advertised detent order lets a fresh handle readback narrow examples
  // to retraction in climb. It does not choose a speed or the next detent.
  if (cue.id === 'surfaces.flaps.set' && choices && phase === 'CLIMB') {
    const currentIndex = input.values.indexOf(observed.flaps);
    if (currentIndex >= 0) choices = choices.filter(value => input.values.indexOf(value) < currentIndex);
  }
  if (input.kind === 'enum' && !choices?.length) return null;
  const hasValue = cue.value != null || Boolean(cue.placeholder);
  if (cue.placeholder && (input.kind !== cue.inputKind || !['enum', 'number'].includes(input.kind))) return null;
  if (cue.value != null) {
    if (input.kind === 'enum' && !choices.includes(cue.value)) return null;
    if (input.kind === 'boolean' && !['on', 'off'].includes(cue.value)) return null;
    if (!['enum', 'boolean'].includes(input.kind)) return null;
  } else if (!cue.placeholder && input.kind !== 'none') return null;
  const pattern = patterns.find(p => typeof p === 'string' && (hasValue ? p.includes('{value}') : !p.includes('{value}')));
  if (!pattern) return null;
  const phrase = pattern.replaceAll('{value}', cue.placeholder ? `[${cue.placeholder}]` : cue.value ?? '').trim();
  if (!phrase || /[{}]/.test(phrase)) return null;
  return { phrase, valueChoices: cue.placeholder && choices ? choices : [], valueHint: cue.placeholder
    ? (choices ? `Choose the appropriate setting: ${choices.join(', ')}.` : `Replace the brackets with your ${cue.placeholder}.`)
    : '' };
}

export function buildFlightVoiceCues({ phase, telemetry = {}, catalogue, available = false, live = false,
  now = Date.now(), pendingCommands = {}, activeProfileKey = '', activeProfileRevision = null,
  aircraftSnapshot = null, arrived = false } = {}) {
  if (!live || !available || !catalogue?.configurationId || !catalogue?.profileKey) return [];
  if (!activeProfileKey || activeProfileKey !== catalogue.profileKey) return [];
  if (activeProfileRevision != null && activeProfileRevision !== catalogue.profileRevision) return [];
  const snapshot = aircraftSnapshot?.activeProfileKey === catalogue.profileKey
    && aircraftSnapshot?.activeProfileRevision === catalogue.profileRevision ? aircraftSnapshot : null;
  // The page clock is throttled; the shared helper also checks actual sample age.
  const readbackNow = Math.max(now, Math.min(now + 1000, snapshot?.receivedAt || now));
  const observed = observedCueConfiguration(catalogue.configurationId, snapshot, readbackNow);
  const pending = new Set(Object.entries(pendingCommands).filter(([, value]) => value === true)
    .map(([key]) => key.startsWith('aircraft-command:') ? key.slice('aircraft-command:'.length) : getAircraftControlCanonicalCommandId(key)));
  // A named detent and a one-step change operate the same control. Suppress
  // both during either request, including any fallback reminder.
  for (const group of [['surfaces.flaps.set', 'surfaces.flaps.adjust'], ['surfaces.spoilers.set', 'surfaces.spoilersArmed.set']]) {
    if (group.some(id => pending.has(id))) group.forEach(id => pending.add(id));
  }
  const result = [];
  const currentPhase = normalizePhase(phase);
  for (const candidate of CUES_BY_PHASE[currentPhase] || []) {
    const cue = aircraftFlightCue(catalogue.configurationId, currentPhase, candidate);
    if (arrived && cue.departureOnly) continue;
    if (cue.when && !cue.when(telemetry, now)) continue;
    if (cue.whenAircraft && !cue.whenAircraft(snapshot, catalogue, readbackNow)) continue;
    if (cue.whenConfiguration && !cue.whenConfiguration(observed)) continue;
    if (cue.fallbackFor && (pending.has(cue.fallbackFor) || result.some(item => item.id === cue.fallbackFor))) continue;
    if (cue.query) {
      if (!snapshot || !answerAircraftStateQuery(cue.query, snapshot,
        { profileKey: catalogue.profileKey, profileRevision: catalogue.profileRevision }, readbackNow)?.ok) continue;
      result.push({ id: `query:${cue.query}`, kind: 'query', label: cue.title, title: flightPhaseBrief(phase).title, detail: cue.detail, phrase: cue.query });
      continue;
    }
    if (pending.has(cue.id) || (cue.id.startsWith('lights.') && [...pending].some(id => id.startsWith('configuration.lights.')))) continue;
    if (cue.id === 'surfaces.autobrake.set' && cue.value != null && cue.value === observed.autobrake) continue;
    if (cue.id === 'surfaces.flaps.set' && cue.value != null && cue.value === observed.flaps) continue;
    if (cue.id === 'surfaces.flaps.adjust' && cue.value === 'decrease' && observed.flaps === 'up') continue;
    const command = catalogue.commands?.[cue.id];
    if (!command || command.kind !== (cue.kind || 'action')) continue;
    if (presetSourceUnavailableReason(command, snapshot, catalogue, readbackNow)) continue;
    // Fault, starting and available indications all make another startup cue unhelpful.
    if (presetObservation(command, snapshot, readbackNow)) continue;
    const speech = speechFor(command, cue, observed, currentPhase);
    if (!speech) continue;
    result.push({ id: command.id, kind: command.kind, label: command.label, title: cue.title,
      detail: cue.detail, description: command.kind === 'preset' ? command.description : '', ...speech });
  }
  return result;
}

export function chooseFlightVoiceCue(options) {
  return buildFlightVoiceCues(options)[0] || null;
}
