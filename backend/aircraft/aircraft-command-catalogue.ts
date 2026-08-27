'use strict';

type GenericRecord = Record<string, any>;

export type AircraftCommandInput = Readonly<
  | { kind: 'none' }
  | { kind: 'boolean' }
  | { kind: 'number'; min: number; max: number; step: number; units: string }
  | { kind: 'enum'; values: readonly string[] }
>;

export type AircraftCommandDefinition = Readonly<{
  description?: string;
  group: string;
  id: string;
  input: AircraftCommandInput;
  kind?: 'action' | 'preset';
  label: string;
  speech?: Readonly<{
    hints?: readonly string[];
    patterns: readonly string[];
  }>;
}>;

type LegacyRequest = Readonly<{
  actionId?: string;
  control: string;
  operation: string;
  target?: string;
  value?: unknown;
}>;

type AircraftCommandBinding = Readonly<{
  commandId: string;
  input?: AircraftCommandInput;
} & (
  | { kind: 'fixed'; request: LegacyRequest }
  | { kind: 'input'; inputKey: string; request: LegacyRequest }
  | { kind: 'choice'; choices: Readonly<Record<string, LegacyRequest>> }
  | {
      kind: 'sequence';
      description: string;
      steps: readonly Readonly<{ label: string; request: LegacyRequest }>[];
    }
  | {
      kind: 'input-sequence';
      description: string;
      inputKey: string;
      steps: readonly Readonly<{ label: string; request: LegacyRequest }>[];
    }
)>;

export type AircraftCommandConfiguration = Readonly<{
  bindings: readonly AircraftCommandBinding[];
  id: string;
}>;

export type NormalizedAircraftCommandRequest = Readonly<{
  commandId: string;
  input: Readonly<Record<string, boolean | number | string>>;
  profileKey: string | null;
  profileRevision: number | null;
  requestId: string | null;
}>;

const NONE_INPUT = Object.freeze({ kind: 'none' } as const);
const BOOLEAN_INPUT = Object.freeze({ kind: 'boolean' } as const);

const AIRCRAFT_COMMAND_DEFINITIONS: Readonly<Record<string, AircraftCommandDefinition>> = Object.freeze(
  Object.fromEntries(([
    {
      id: 'flightGuidance.heading.set', label: 'Selected heading', group: 'flightGuidance',
      input: { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' },
      speech: { patterns: ['set heading {value}', 'heading {value}'], hints: ['HEADING'] },
    },
    {
      id: 'flightGuidance.course.setBoth',
      label: 'Captain + FO course windows',
      description: 'Set both MCP course windows to the same course.',
      group: 'flightGuidance',
      input: { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' },
      speech: {
        patterns: [
          'set course {value}',
          'set courses {value}',
          'set both course {value}',
          'set both courses {value}',
          'set course windows {value}',
          'set both course windows {value}',
        ],
        hints: ['SET COURSE', 'SET COURSES', 'COURSE WINDOWS'],
      },
    },
    {
      id: 'flightGuidance.altitude.set', label: 'Selected altitude', group: 'flightGuidance',
      input: { kind: 'number', min: 0, max: 60000, step: 100, units: 'feet' },
      speech: {
        patterns: [
          'set altitude {value}',
          'altitude {value}',
          'set flight level {value}',
          'flight level {value}',
        ],
        hints: ['ALTITUDE', 'FLIGHT LEVEL'],
      },
    },
    {
      id: 'flightGuidance.speed.set', label: 'Selected speed', group: 'flightGuidance',
      input: { kind: 'number', min: 0, max: 999, step: 1, units: 'knots' },
      speech: { patterns: ['set speed {value}', 'speed {value}'], hints: ['SPEED'] },
    },
    {
      id: 'flightGuidance.mach.set', label: 'Selected Mach', group: 'flightGuidance',
      input: { kind: 'number', min: 0.4, max: 0.99, step: 0.01, units: 'mach' },
      speech: { patterns: ['set mach {value}', 'mach {value}'], hints: ['MACH'] },
    },
    {
      id: 'flightGuidance.verticalSpeed.set', label: 'Selected vertical speed', group: 'flightGuidance',
      input: { kind: 'number', min: -9900, max: 9900, step: 100, units: 'feet-per-minute' },
      speech: {
        patterns: ['set vertical speed {value}', 'vertical speed {value}'],
        hints: ['VERTICAL SPEED'],
      },
    },
    {
      id: 'flightGuidance.autopilot.set', label: 'Autopilot master', group: 'flightGuidance',
      input: BOOLEAN_INPUT,
      speech: { patterns: ['autopilot {value}'], hints: ['AUTOPILOT'] },
    },
    {
      id: 'flightGuidance.autopilot1.engage', label: 'Autopilot 1', group: 'flightGuidance',
      input: NONE_INPUT,
      speech: { patterns: ['engage autopilot one', 'command a'], hints: ['COMMAND A'] },
    },
    ...[
      ['flightGuidance.autopilot.toggle', 'Autopilot master'],
      ['flightGuidance.autothrottle.toggle', 'Autothrottle'],
      ['flightGuidance.flightDirector.toggle', 'Flight director'],
      ['flightGuidance.machHold.toggle', 'Mach hold'],
      ['flightGuidance.headingHold.toggle', 'Heading hold'],
      ['flightGuidance.altitudeHold.toggle', 'Altitude hold'],
      ['flightGuidance.verticalSpeedHold.toggle', 'Vertical speed mode'],
      ['flightGuidance.localizer.toggle', 'Localizer mode'],
      ['flightGuidance.approach.toggle', 'Approach mode'],
      ['flightGuidance.nav1.toggle', 'VOR/NAV 1'],
      ['flightGuidance.ins.toggle', 'INS navigation'],
      ['flightGuidance.backcourse.toggle', 'Back course'],
    ].map(([id, label]) => ({ id, label, group: 'flightGuidance', input: NONE_INPUT })),
    ...[
      ['flightGuidance.headingSelect.engage', 'Heading select', 'HEADING SELECT'],
      ['flightGuidance.altitudeHold.engage', 'Altitude hold', 'ALTITUDE HOLD'],
      ['flightGuidance.verticalSpeed.engage', 'Vertical speed mode', 'VERTICAL SPEED'],
      ['flightGuidance.flightLevelChange.engage', 'Level change', 'LEVEL CHANGE'],
      ['flightGuidance.localizer.engage', 'VOR/LOC', 'VOR LOCALIZER'],
      ['flightGuidance.approach.engage', 'Approach mode', 'APPROACH'],
    ].map(([id, label, hint]) => ({
      id,
      label,
      group: 'flightGuidance',
      input: NONE_INPUT,
      speech: { patterns: [`engage ${label.toLowerCase()}`], hints: [hint] },
    })),
    {
      id: 'flightGuidance.speedHold.set', label: 'Speed hold', group: 'flightGuidance',
      input: BOOLEAN_INPUT,
    },
    {
      id: 'flightGuidance.headingHold.set', label: 'Heading hold', group: 'flightGuidance',
      input: BOOLEAN_INPUT,
      speech: { patterns: ['heading hold {value}'], hints: ['HEADING HOLD'] },
    },
    {
      id: 'flightGuidance.altitudeHold.set', label: 'Altitude hold', group: 'flightGuidance',
      input: BOOLEAN_INPUT,
      speech: { patterns: ['altitude hold {value}'], hints: ['ALTITUDE HOLD'] },
    },
    {
      id: 'flightGuidance.verticalSpeedHold.set', label: 'Vertical speed mode', group: 'flightGuidance',
      input: BOOLEAN_INPUT,
      speech: { patterns: ['vertical speed mode {value}'], hints: ['VERTICAL SPEED'] },
    },
    {
      id: 'flightGuidance.flightLevelChange.set', label: 'Flight level change', group: 'flightGuidance',
      input: BOOLEAN_INPUT,
      speech: { patterns: ['flight level change {value}'], hints: ['FLIGHT LEVEL CHANGE'] },
    },
    {
      id: 'flightGuidance.localizer.set', label: 'Localizer mode', group: 'flightGuidance',
      input: BOOLEAN_INPUT,
      speech: { patterns: ['localizer {value}'], hints: ['LOCALIZER'] },
    },
    {
      id: 'flightGuidance.approach.set', label: 'Approach mode', group: 'flightGuidance',
      input: BOOLEAN_INPUT,
      speech: { patterns: ['approach mode {value}'], hints: ['APPROACH'] },
    },
    {
      id: 'surfaces.gear.set', label: 'Landing gear', group: 'surfaces',
      input: { kind: 'enum', values: ['up', 'down'] },
      speech: { patterns: ['gear {value}', 'landing gear {value}'], hints: ['LANDING GEAR'] },
    },
    {
      id: 'surfaces.flaps.adjust', label: 'Flaps one detent', group: 'surfaces',
      input: { kind: 'enum', values: ['increase', 'decrease'] },
      speech: {
        patterns: ['flaps {value} one', 'flaps one detent {value}'],
        hints: ['FLAPS'],
      },
    },
    {
      id: 'surfaces.flaps.set', label: 'Flap detent', group: 'surfaces',
      input: { kind: 'enum', values: ['up', '1', '2', '5', '10', '15', '25', '30', '40'] },
      speech: { patterns: ['set flaps {value}', 'flaps {value}'], hints: ['FLAPS'] },
    },
    {
      id: 'surfaces.parkingBrake.set', label: 'Parking brake', group: 'surfaces',
      input: BOOLEAN_INPUT,
      speech: {
        patterns: ['parking brake {value}', '{value} parking brake'],
        hints: ['PARKING BRAKE'],
      },
    },
    {
      id: 'surfaces.spoilers.set', label: 'Spoilers', group: 'surfaces',
      input: { kind: 'enum', values: ['retracted', 'full'] },
      speech: { patterns: ['spoilers {value}'], hints: ['SPOILERS'] },
    },
    {
      id: 'surfaces.spoilersArmed.set', label: 'Ground spoilers', group: 'surfaces',
      input: BOOLEAN_INPUT,
      speech: {
        patterns: [
          'ground spoilers {value}',
          '{value} ground spoilers',
          '{value} spoilers',
          'speed brake {value}',
          '{value} speed brake',
        ],
        hints: ['GROUND SPOILERS', 'SPOILERS', 'SPEED BRAKE'],
      },
    },
    {
      id: 'radios.nav.setBothActive',
      label: 'NAV 1 + NAV 2 active frequency',
      description: 'Set both active NAV radios to the same frequency.',
      group: 'radios',
      input: { kind: 'number', min: 108, max: 117.95, step: 0.05, units: 'megahertz' },
      speech: {
        patterns: [
          'set nav radios {value}',
          'set both nav radios {value}',
          'tune nav radios {value}',
        ],
        hints: ['SET NAV RADIOS', 'NAV RADIOS'],
      },
    },
    {
      id: 'configuration.lighting.cockpit',
      label: 'Cockpit lighting',
      description: 'Set PMDG 737 panel, flood and display-unit dimmers to one brightness.',
      group: 'presets',
      kind: 'preset',
      input: { kind: 'number', min: 0, max: 100, step: 1, units: 'percent' },
      speech: {
        patterns: [
          'set cockpit lighting {value}',
          'set cockpit lights {value}',
          'set all cockpit lights {value}',
        ],
        hints: ['SET COCKPIT LIGHTING', 'COCKPIT LIGHTS'],
      },
    },
    {
      id: 'configuration.lights.takeoff',
      label: 'Takeoff lights',
      description: 'Apply the reviewed takeoff-light configuration for the active aircraft.',
      group: 'presets',
      kind: 'preset',
      input: NONE_INPUT,
      speech: {
        patterns: ['set lights for takeoff', 'takeoff lights'],
        hints: ['TAKEOFF LIGHTS', 'LIGHTS FOR TAKEOFF'],
      },
    },
    ...['nav', 'beacon', 'strobe', 'landing', 'taxi'].map((light) => ({
      id: `lights.${light}.set`,
      label: `${light[0].toUpperCase()}${light.slice(1)} lights`,
      group: 'lights',
      input: BOOLEAN_INPUT,
      speech: {
        patterns: [`${light} lights {value}`, `${light} light {value}`],
        hints: [`${light.toUpperCase()} LIGHTS`],
      },
    })),
  ] as AircraftCommandDefinition[]).map((definition) => [definition.id, Object.freeze(definition)])),
);

function fixed(commandId: string, request: LegacyRequest): AircraftCommandBinding {
  return Object.freeze({ commandId, kind: 'fixed', request: Object.freeze({ ...request }) });
}

function input(
  commandId: string,
  request: LegacyRequest,
  inputKey = 'value',
  inputOverride?: AircraftCommandInput,
): AircraftCommandBinding {
  return Object.freeze({
    commandId,
    kind: 'input',
    inputKey,
    request: Object.freeze({ ...request }),
    ...(inputOverride ? { input: Object.freeze(inputOverride) } : {}),
  });
}

function choice(
  commandId: string,
  choices: Record<string, LegacyRequest>,
  inputOverride?: AircraftCommandInput,
): AircraftCommandBinding {
  return Object.freeze({
    commandId,
    kind: 'choice',
    choices: Object.freeze(Object.fromEntries(
      Object.entries(choices).map(([key, request]) => [key, Object.freeze({ ...request })]),
    )),
    ...(inputOverride ? { input: Object.freeze(inputOverride) } : {}),
  });
}

function sequence(
  commandId: string,
  description: string,
  steps: readonly Readonly<{ label: string; request: LegacyRequest }>[],
): AircraftCommandBinding {
  return Object.freeze({
    commandId,
    kind: 'sequence',
    description,
    steps: Object.freeze(steps.map((step) => Object.freeze({
      label: step.label,
      request: Object.freeze({ ...step.request }),
    }))),
  });
}

function inputSequence(
  commandId: string,
  description: string,
  steps: readonly Readonly<{ label: string; request: LegacyRequest }>[],
  inputKey = 'value',
  inputOverride?: AircraftCommandInput,
): AircraftCommandBinding {
  return Object.freeze({
    commandId,
    kind: 'input-sequence',
    description,
    inputKey,
    steps: Object.freeze(steps.map((step) => Object.freeze({
      label: step.label,
      request: Object.freeze({ ...step.request }),
    }))),
    ...(inputOverride ? { input: Object.freeze(inputOverride) } : {}),
  });
}

const genericBoolean = (control: string, target?: string): LegacyRequest => ({
  control,
  operation: 'set',
  ...(target ? { target } : {}),
});

export const GENERIC_AIRCRAFT_COMMAND_CONFIGURATION: AircraftCommandConfiguration = Object.freeze({
  id: 'generic',
  bindings: Object.freeze([
    input('flightGuidance.heading.set', { control: 'autopilot', target: 'heading', operation: 'set' }),
    input('flightGuidance.altitude.set', { control: 'autopilot', target: 'altitude', operation: 'set' }),
    input('flightGuidance.speed.set', { control: 'autopilot', target: 'speed', operation: 'set' }),
    input('flightGuidance.verticalSpeed.set', { control: 'autopilot', target: 'verticalSpeed', operation: 'set' }),
    input('flightGuidance.autopilot.set', genericBoolean('autopilot', 'master')),
    fixed('flightGuidance.autopilot.toggle', { control: 'autopilot', target: 'master', operation: 'toggle' }),
    fixed('flightGuidance.autothrottle.toggle', { control: 'autopilot', target: 'autothrottle', operation: 'toggle' }),
    fixed('flightGuidance.flightDirector.toggle', { control: 'autopilot', target: 'flightDirector', operation: 'toggle' }),
    fixed('flightGuidance.machHold.toggle', { control: 'autopilot', target: 'machHold', operation: 'toggle' }),
    fixed('flightGuidance.headingHold.toggle', { control: 'autopilot', target: 'headingHold', operation: 'toggle' }),
    fixed('flightGuidance.altitudeHold.toggle', { control: 'autopilot', target: 'altitudeHold', operation: 'toggle' }),
    fixed('flightGuidance.verticalSpeedHold.toggle', { control: 'autopilot', target: 'verticalSpeedHold', operation: 'toggle' }),
    fixed('flightGuidance.localizer.toggle', { control: 'autopilot', target: 'loc', operation: 'toggle' }),
    fixed('flightGuidance.approach.toggle', { control: 'autopilot', target: 'app', operation: 'toggle' }),
    fixed('flightGuidance.nav1.toggle', { control: 'autopilot', target: 'nav1', operation: 'toggle' }),
    fixed('flightGuidance.ins.toggle', { control: 'autopilot', target: 'ins', operation: 'toggle' }),
    fixed('flightGuidance.backcourse.toggle', { control: 'autopilot', target: 'backcourse', operation: 'toggle' }),
    input('flightGuidance.speedHold.set', genericBoolean('autopilot', 'speedHold')),
    input('flightGuidance.headingHold.set', genericBoolean('autopilot', 'headingHold')),
    input('flightGuidance.altitudeHold.set', genericBoolean('autopilot', 'altitudeHold')),
    input('flightGuidance.verticalSpeedHold.set', genericBoolean('autopilot', 'verticalSpeedHold')),
    input('flightGuidance.flightLevelChange.set', genericBoolean('autopilot', 'flightLevelChange')),
    input('flightGuidance.localizer.set', genericBoolean('autopilot', 'loc')),
    input('flightGuidance.approach.set', genericBoolean('autopilot', 'app')),
    choice('surfaces.gear.set', {
      up: { control: 'gear', operation: 'up' },
      down: { control: 'gear', operation: 'down' },
    }),
    choice('surfaces.flaps.adjust', {
      increase: { control: 'flaps', operation: 'increment' },
      decrease: { control: 'flaps', operation: 'decrement' },
    }),
    input('surfaces.parkingBrake.set', genericBoolean('parkingBrake')),
    choice('surfaces.spoilers.set', {
      retracted: { control: 'spoilers', operation: 'set', value: 0 },
      full: { control: 'spoilers', operation: 'set', value: 16383 },
    }),
    choice('surfaces.spoilersArmed.set', {
      false: { control: 'spoilers', operation: 'disarm' },
      true: { control: 'spoilers', operation: 'arm' },
    }, BOOLEAN_INPUT),
    sequence(
      'configuration.lights.takeoff',
      'Landing ON · Taxi ON · Strobe ON',
      [
        { label: 'Landing lights ON', request: { ...genericBoolean('lights', 'landing'), value: true } },
        { label: 'Taxi lights ON', request: { ...genericBoolean('lights', 'taxi'), value: true } },
        { label: 'Strobe lights ON', request: { ...genericBoolean('lights', 'strobe'), value: true } },
      ],
    ),
    ...['nav', 'beacon', 'strobe', 'landing', 'taxi'].map((light) => (
      input(`lights.${light}.set`, genericBoolean('lights', light))
    )),
  ]),
});

const aircraftAction = (actionId: string): LegacyRequest => ({
  control: 'aircraft-specific',
  operation: 'execute',
  actionId,
  target: actionId,
});

export const PMDG_737_AIRCRAFT_COMMAND_CONFIGURATION: AircraftCommandConfiguration = Object.freeze({
  id: 'pmdg-737',
  bindings: Object.freeze([
    input(
      'flightGuidance.heading.set',
      aircraftAction('mcp.heading.set'),
      'value',
      { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' },
    ),
    input(
      'flightGuidance.course.setBoth',
      aircraftAction('mcp.courseBoth.set'),
      'value',
      { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' },
    ),
    input(
      'flightGuidance.altitude.set',
      aircraftAction('mcp.altitude.set'),
      'value',
      { kind: 'number', min: 0, max: 50000, step: 100, units: 'feet' },
    ),
    input(
      'flightGuidance.speed.set',
      aircraftAction('mcp.ias.set'),
      'value',
      { kind: 'number', min: 100, max: 399, step: 1, units: 'knots' },
    ),
    input('flightGuidance.mach.set', aircraftAction('mcp.mach.set')),
    input(
      'flightGuidance.verticalSpeed.set',
      aircraftAction('mcp.verticalSpeed.set'),
      'value',
      { kind: 'number', min: -7900, max: 6000, step: 100, units: 'feet-per-minute' },
    ),
    fixed('flightGuidance.autopilot1.engage', aircraftAction('afds.cmdA.engage')),
    fixed('flightGuidance.headingSelect.engage', aircraftAction('afds.headingSelect.engage')),
    fixed('flightGuidance.altitudeHold.engage', aircraftAction('afds.altitudeHold.engage')),
    fixed('flightGuidance.verticalSpeed.engage', aircraftAction('afds.verticalSpeed.engage')),
    fixed('flightGuidance.flightLevelChange.engage', aircraftAction('afds.levelChange.engage')),
    fixed('flightGuidance.localizer.engage', aircraftAction('afds.vorLoc.engage')),
    fixed('flightGuidance.approach.engage', aircraftAction('afds.approach.engage')),
    choice('surfaces.gear.set', {
      up: aircraftAction('gear.handle.up'),
      down: aircraftAction('gear.handle.down'),
    }),
    choice('surfaces.flaps.set', {
      up: aircraftAction('flightControls.flaps.up'),
      1: aircraftAction('flightControls.flaps.detent1'),
      2: aircraftAction('flightControls.flaps.detent2'),
      5: aircraftAction('flightControls.flaps.detent5'),
      10: aircraftAction('flightControls.flaps.detent10'),
      15: aircraftAction('flightControls.flaps.detent15'),
      25: aircraftAction('flightControls.flaps.detent25'),
      30: aircraftAction('flightControls.flaps.detent30'),
      40: aircraftAction('flightControls.flaps.detent40'),
    }),
    choice('surfaces.parkingBrake.set', {
      false: aircraftAction('gear.parkingBrake.released'),
      true: aircraftAction('gear.parkingBrake.set'),
    }, BOOLEAN_INPUT),
    choice('surfaces.spoilersArmed.set', {
      false: aircraftAction('flightControls.speedbrake.disarm'),
      true: aircraftAction('flightControls.speedbrake.arm'),
    }, BOOLEAN_INPUT),
    inputSequence(
      'configuration.lighting.cockpit',
      '16 dimmers · panel backlighting · flood lighting · flight displays',
      [
        { label: 'Panel backlighting', request: aircraftAction('lighting.cockpit.panels.set') },
        { label: 'Flood and background lighting', request: aircraftAction('lighting.cockpit.ambient.set') },
        { label: 'Captain and upper displays', request: aircraftAction('lighting.cockpit.captainDisplays.set') },
        { label: 'First Officer and lower displays', request: aircraftAction('lighting.cockpit.firstOfficerDisplays.set') },
      ],
      'value',
      { kind: 'number', min: 0, max: 100, step: 1, units: 'percent' },
    ),
    input(
      'radios.nav.setBothActive',
      aircraftAction('radios.navBoth.setActive'),
      'value',
      { kind: 'number', min: 108, max: 117.95, step: 0.05, units: 'megahertz' },
    ),
    choice('lights.taxi.set', {
      false: aircraftAction('lights.taxi.off'),
      true: aircraftAction('lights.taxi.on'),
    }, BOOLEAN_INPUT),
    sequence(
      'configuration.lights.takeoff',
      'Landing L/R ON · Runway turnoffs ON · Taxi ON · Position STROBE + STEADY',
      [
        { label: 'Retractable landing light left ON', request: aircraftAction('lights.landingRetractableLeft.on') },
        { label: 'Retractable landing light right ON', request: aircraftAction('lights.landingRetractableRight.on') },
        { label: 'Fixed landing light left ON', request: aircraftAction('lights.landingLeft.on') },
        { label: 'Fixed landing light right ON', request: aircraftAction('lights.landingRight.on') },
        { label: 'Runway turnoff light left ON', request: aircraftAction('lights.turnoffLeft.on') },
        { label: 'Runway turnoff light right ON', request: aircraftAction('lights.turnoffRight.on') },
        { label: 'Taxi light ON', request: aircraftAction('lights.taxi.on') },
        { label: 'Position lights STROBE + STEADY', request: aircraftAction('lights.position.strobeSteady') },
      ],
    ),
  ]),
});

const CONFIGURATIONS_BY_ADAPTER = new Map<string, AircraftCommandConfiguration>([
  ['pmdg-737', PMDG_737_AIRCRAFT_COMMAND_CONFIGURATION],
]);

function getDeclaredAdapterId(profile: unknown): string {
  const adapter = (profile as GenericRecord | null)?.integration?.aircraftSpecific?.adapter;
  return typeof adapter === 'string' ? adapter.trim() : '';
}

export function resolveAircraftCommandConfiguration(profile: unknown): AircraftCommandConfiguration {
  return CONFIGURATIONS_BY_ADAPTER.get(getDeclaredAdapterId(profile))
    || GENERIC_AIRCRAFT_COMMAND_CONFIGURATION;
}

function normalizeProfileKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 180 ? trimmed : null;
}

function normalizeProfileRevision(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

export function normalizeAircraftCommandRequest(rawRequest: unknown): NormalizedAircraftCommandRequest | null {
  if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) return null;
  const request = rawRequest as GenericRecord;
  const commandId = typeof request.commandId === 'string' ? request.commandId.trim() : '';
  if (!Object.prototype.hasOwnProperty.call(AIRCRAFT_COMMAND_DEFINITIONS, commandId)) return null;
  if (request.input != null && (typeof request.input !== 'object' || Array.isArray(request.input))) return null;
  return Object.freeze({
    commandId,
    input: Object.freeze({ ...(request.input || {}) }),
    profileKey: normalizeProfileKey(request.profileKey ?? request.expectedProfileKey),
    profileRevision: normalizeProfileRevision(request.profileRevision ?? request.expectedProfileRevision),
    requestId: typeof request.requestId === 'string' && request.requestId.trim()
      ? request.requestId.trim().slice(0, 160)
      : null,
  });
}

function isStepAligned(value: number, min: number, step: number): boolean {
  const quotient = (value - min) / step;
  return Math.abs(quotient - Math.round(quotient)) < 1e-7;
}

function normalizeCommandInput(
  definition: AircraftCommandDefinition,
  binding: AircraftCommandBinding,
  rawInput: Readonly<Record<string, unknown>>,
): Readonly<{ ok: true; input: Readonly<Record<string, boolean | number | string>> } | { ok: false; error: string }> {
  const contract = binding.input || definition.input;
  const keys = Object.keys(rawInput);
  if (contract.kind === 'none') {
    if (keys.length > 0) return { ok: false, error: `${definition.label} does not accept input.` };
    return { ok: true, input: Object.freeze({}) };
  }
  if (keys.length !== 1 || keys[0] !== 'value') {
    return { ok: false, error: `${definition.label} requires exactly one value.` };
  }
  const value = rawInput.value;
  if (contract.kind === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, error: `${definition.label} requires an on/off value.` };
    return { ok: true, input: Object.freeze({ value }) };
  }
  if (contract.kind === 'enum') {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : String(value);
    if (!contract.values.includes(normalized)) {
      return { ok: false, error: `${definition.label} requires one of: ${contract.values.join(', ')}.` };
    }
    return { ok: true, input: Object.freeze({ value: normalized }) };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: `${definition.label} requires a finite numeric value.` };
  }
  if (value < contract.min || value > contract.max || !isStepAligned(value, contract.min, contract.step)) {
    return {
      ok: false,
      error: `${definition.label} must be ${contract.min} to ${contract.max} in steps of ${contract.step}.`,
    };
  }
  return { ok: true, input: Object.freeze({ value }) };
}

function requestsForBinding(
  binding: AircraftCommandBinding,
  inputValue: Readonly<Record<string, boolean | number | string>>,
): readonly Readonly<{ label: string; request: LegacyRequest }>[] | null {
  if (binding.kind === 'sequence') {
    return binding.steps.map((step) => ({ label: step.label, request: { ...step.request } }));
  }
  if (binding.kind === 'input-sequence') {
    return binding.steps.map((step) => ({
      label: step.label,
      request: { ...step.request, value: inputValue[binding.inputKey] },
    }));
  }
  if (binding.kind === 'fixed') return [{ label: '', request: { ...binding.request } }];
  if (binding.kind === 'input') {
    return [{ label: '', request: { ...binding.request, value: inputValue[binding.inputKey] } }];
  }
  const key = String(inputValue.value);
  return Object.prototype.hasOwnProperty.call(binding.choices, key)
    ? [{ label: '', request: { ...binding.choices[key] } }]
    : null;
}

export function resolveAircraftCommandRequest(rawRequest: unknown, profile: unknown): GenericRecord {
  const request = normalizeAircraftCommandRequest(rawRequest);
  if (!request) {
    return { ok: false, code: 'invalid_command_request', error: 'Invalid aircraft command request.' };
  }
  const configuration = resolveAircraftCommandConfiguration(profile);
  const binding = configuration.bindings.find((candidate) => candidate.commandId === request.commandId);
  if (!binding) {
    return {
      ok: false,
      code: 'unsupported_command',
      error: 'The active aircraft does not support this command.',
      command: request,
      configurationId: configuration.id,
    };
  }
  const definition = AIRCRAFT_COMMAND_DEFINITIONS[request.commandId];
  const normalizedInput = normalizeCommandInput(definition, binding, request.input);
  if (normalizedInput.ok === false) {
    return {
      ok: false,
      code: 'invalid_command_input',
      error: normalizedInput.error,
      command: request,
      configurationId: configuration.id,
    };
  }
  const boundSteps = requestsForBinding(binding, normalizedInput.input);
  if (!boundSteps || boundSteps.length === 0) {
    return {
      ok: false,
      code: 'invalid_command_input',
      error: 'The command value is not mapped for the active aircraft.',
      command: request,
      configurationId: configuration.id,
    };
  }
  const controlSteps = boundSteps.map((step) => Object.freeze({
    label: step.label || definition.label,
    request: Object.freeze({
      ...step.request,
      profileKey: request.profileKey,
      profileRevision: request.profileRevision,
      requestId: request.requestId,
    }),
  }));
  const controlRequests = controlSteps.map((step) => step.request);
  return {
    ok: true,
    command: Object.freeze({ ...request, input: normalizedInput.input }),
    configurationId: configuration.id,
    controlRequest: controlRequests[0],
    controlRequests,
    controlSteps,
    definition,
    input: binding.input || definition.input,
    kind: binding.kind === 'sequence' || binding.kind === 'input-sequence' ? 'preset' : 'action',
  };
}

function sampleInputs(inputContract: AircraftCommandInput): readonly Readonly<Record<string, boolean | number | string>>[] {
  switch (inputContract.kind) {
    case 'none': return Object.freeze([Object.freeze({})]);
    case 'boolean': return Object.freeze([
      Object.freeze({ value: false }),
      Object.freeze({ value: true }),
    ]);
    case 'number': return Object.freeze([Object.freeze({ value: inputContract.min })]);
    case 'enum': return Object.freeze(inputContract.values.map((value) => Object.freeze({ value })));
    default: return Object.freeze([Object.freeze({})]);
  }
}

export function buildAircraftCommandCatalogue(
  profile: unknown,
  options: {
    profileRevision?: unknown;
    resolveControl: (request: unknown) => GenericRecord;
  },
): GenericRecord {
  const configuration = resolveAircraftCommandConfiguration(profile);
  const profileKey = String(
    (profile as GenericRecord | null)?._profileKey
      || (profile as GenericRecord | null)?._qualifiedId
      || (profile as GenericRecord | null)?.id
      || 'generic',
  );
  const commands: GenericRecord[] = [];
  const inventory: GenericRecord[] = [];
  for (const binding of configuration.bindings) {
    const definition = AIRCRAFT_COMMAND_DEFINITIONS[binding.commandId];
    if (!definition) continue;
    const inputContract = binding.input || definition.input;
    const actionIds = new Set<string>();
    let allRoutesAvailable = true;
    for (const commandInput of sampleInputs(inputContract)) {
      const resolved = resolveAircraftCommandRequest({
        commandId: definition.id,
        input: commandInput,
      }, profile);
      if (resolved.ok !== true) {
        allRoutesAvailable = false;
        continue;
      }
      for (const request of resolved.controlRequests as LegacyRequest[]) {
        if (
          request.control === 'aircraft-specific'
          && typeof request.actionId === 'string'
          && request.actionId
        ) {
          actionIds.add(request.actionId);
        }
      }
      if (!resolved.controlRequests.every(
        (request: LegacyRequest) => options.resolveControl(request).ok === true,
      )) allRoutesAvailable = false;
    }
    const descriptor = {
      id: definition.id,
      label: definition.label,
      group: definition.group,
      kind: definition.kind || 'action',
      input: inputContract,
      ...(binding.kind === 'sequence' || binding.kind === 'input-sequence'
        ? { description: binding.description }
        : (definition.description ? { description: definition.description } : {})),
      ...(definition.speech ? { speech: definition.speech } : {}),
    };
    inventory.push({
      ...descriptor,
      supported: allRoutesAvailable,
      ...(actionIds.size > 0 ? { actionIds: [...actionIds] } : {}),
    });
    if (allRoutesAvailable) commands.push(descriptor);
  }
  return {
    configurationId: configuration.id,
    profileKey,
    profileRevision: normalizeProfileRevision(options.profileRevision),
    commands,
    inventory,
  };
}

export function getAircraftCommandDefinition(commandId: unknown): AircraftCommandDefinition | null {
  if (typeof commandId !== 'string') return null;
  return AIRCRAFT_COMMAND_DEFINITIONS[commandId] || null;
}

module.exports = {
  AIRCRAFT_COMMAND_DEFINITIONS,
  GENERIC_AIRCRAFT_COMMAND_CONFIGURATION,
  PMDG_737_AIRCRAFT_COMMAND_CONFIGURATION,
  buildAircraftCommandCatalogue,
  getAircraftCommandDefinition,
  normalizeAircraftCommandRequest,
  resolveAircraftCommandConfiguration,
  resolveAircraftCommandRequest,
};
