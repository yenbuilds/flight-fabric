import type { AircraftCommandBinding, AircraftCommandDefinition, AircraftCommandInput } from './aircraft-command-catalogue';

const booleanInput = { kind: 'boolean' } as const;
const enumInput = (values: readonly string[]): AircraftCommandInput => ({ kind: 'enum', values });
const action = (actionId: string) => ({ control: 'aircraft-specific', operation: 'execute', actionId, target: actionId });

function definition(id: string, label: string, input: AircraftCommandInput, phrases: string[] = [label.toLowerCase()]): AircraftCommandDefinition {
  return { id, label, group: id.split('.')[0], input,
    speech: { patterns: phrases.flatMap(phrase => [`${phrase} {value}`, `set ${phrase} {value}`]),
      hints: phrases.map(phrase => phrase.toUpperCase()) } };
}

/** Shared intent only. Each family below explicitly selects its own existing actions. */
export const PARITY_COMMAND_DEFINITIONS: readonly AircraftCommandDefinition[] = [
  ...[
    ['lights.wing.set', 'Wing lights'], ['lights.logo.set', 'Logo lights'], ['lights.wheelWell.set', 'Wheel well lights'],
    ['flightGuidance.flightDirector.set', 'Flight director'], ['flightGuidance.autothrottleArm.set', 'Autothrottle arm'],
    ['flightGuidance.navHold.set', 'NAV hold'], ['flightGuidance.metricAltitude.set', 'Metric altitude'],
    ['systems.ramAir.set', 'Ram air'], ['systems.apuMaster.set', 'APU master'],
    ['systems.apuGenerator.set', 'APU generator'], ['systems.externalPower.set', 'External power'],
    ['systems.brakeFan.set', 'Brake fans'], ['surfaces.yawDamper.set', 'Yaw damper'],
  ].map(([id, label]) => definition(id, label, booleanInput)),
  ...[
    ['cabin.seatBelts.set', 'Seat belts', ['seat belts', 'seatbelts', 'seat belt signs']],
    ['cabin.noSmoking.set', 'No smoking signs', ['no smoking', 'no smoking signs']],
    ['cabin.noMobile.set', 'No mobile signs', ['no mobile signs']],
  ].map(([id, label, phrases]) => definition(id as string, label as string, enumInput(['off', 'auto', 'on']), phrases as string[])),
  definition('cabin.emergencyExit.set', 'Emergency lights', enumInput(['off', 'arm', 'on']), ['emergency lights', 'emergency exit lights']),
  definition('lights.logoMode.set', 'Logo light mode', enumInput(['off', 'auto', 'on'])),
  definition('lights.positionMode.set', 'Position lights', enumInput(['off', 'steady', 'strobe']), ['position lights']),
  definition('systems.apuBleed.set', 'APU bleed', enumInput(['off', 'on', 'auto'])),
  definition('systems.wingAntiIce.set', 'Wing anti ice', enumInput(['off', 'auto', 'on'])),
  definition('systems.probeHeat.set', 'Probe heat', enumInput(['auto', 'on']), ['probe heat', 'probe window heat']),
  definition('systems.crossBleed.set', 'Cross bleed', enumInput(['closed', 'auto', 'open']), ['cross bleed', 'crossbleed']),
  definition('systems.packFlow.set', 'Pack flow', enumInput(['low', 'normal', 'high', 'manual'])),
  ...(['captain', 'firstOfficer'] as const).flatMap(side => {
    const word = side === 'captain' ? 'captain' : 'first officer';
    return [
      definition(`visibility.${side}.wiper`, `${word} wiper`, enumInput(['off', 'intermittent', 'low', 'high', 'slow', 'fast'])),
      definition(`navigation.${side}.mode`, `${word} ND mode`, enumInput(['ils', 'vor', 'nav', 'arc', 'plan', 'approach', 'map']),
        [`${word} nd mode`, `${word} navigation display mode`]),
      definition(`navigation.${side}.terrain`, `${word} terrain display`, booleanInput, [`${word} terrain`, `${word} terrain display`]),
      definition(`flightGuidance.course.${side}`, `${word} course`, { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' }),
      definition(`flightGuidance.${side}.verticalView`, `${word} vertical view`, booleanInput),
    ];
  }),
  ...([1, 2] as const).flatMap(index => {
    const word = index === 1 ? 'one' : 'two';
    return [
      definition(`systems.engineAntiIce${index}.set`, `Engine ${index} anti ice`, enumInput(['off', 'auto', 'on']),
        [`engine ${word} anti ice`, `engine ${index} anti ice`]),
      definition(`systems.engineBleed${index}.set`, `Engine ${index} bleed`, enumInput(['off', 'auto', 'on']),
        [`engine ${word} bleed`, `engine ${index} bleed`]),
      definition(`systems.pack${index}.set`, `Pack ${index}`, enumInput(['off', 'auto', 'on', 'high']), [`pack ${word}`, `pack ${index}`]),
      definition(`systems.battery${index}.set`, `Battery ${index}`, enumInput(['off', 'auto', 'on']), [`battery ${word}`, `battery ${index}`]),
    ];
  }),
  ...[
    ['flightGuidance.speed.engage', 'MCP speed', ['engage mcp speed', 'engage speed mode']],
    ['flightGuidance.n1.engage', 'N1 mode', ['engage n one', 'engage n1']],
  ].map(([id, label, patterns]) => ({ id: id as string, label: label as string, group: 'flightGuidance',
    input: { kind: 'none' } as const, speech: { patterns: patterns as string[], hints: [(label as string).toUpperCase()] } })),
];

export function aircraftParityBindings(adapterId: string): readonly AircraftCommandBinding[] {
  const bindings: AircraftCommandBinding[] = [];
  const choose = (commandId: string, choices: Record<string, ReturnType<typeof action>>, input = enumInput(Object.keys(choices))) =>
    bindings.push({ commandId, kind: 'choice', choices, input });
  const positions = (commandId: string, prefix: string, names: readonly string[], suffixes: readonly string[] = names) =>
    choose(commandId, Object.fromEntries(names.map((name, index) => [name, action(`${prefix}.${suffixes[index]}`)])));
  const onOff = (commandId: string, prefix: string, off = 'off', on = 'on') =>
    choose(commandId, { false: action(`${prefix}.${off}`), true: action(`${prefix}.${on}`) }, booleanInput);
  const fixed = (commandId: string, actionId: string) => bindings.push({ commandId, kind: 'fixed', request: action(actionId) });
  const number = (commandId: string, actionId: string, min: number, max: number, step: number, units: string) =>
    bindings.push({ commandId, kind: 'input', inputKey: 'value', request: action(actionId), input: { kind: 'number', min, max, step, units } });
  const pmdg = adapterId === 'pmdg-737' || adapterId === 'pmdg-777';
  const airbus = adapterId === 'fenix-a32x' || adapterId === 'fbw-a32nx';
  const standard = adapterId === 'microsoft-737-max-8' || adapterId === 'microsoft-inibuilds-a32x';

  if (pmdg || airbus || adapterId === 'inibuilds-a350') {
    positions('cabin.seatBelts.set', 'cabin.seatBelts', airbus ? ['off', 'on'] : ['off', 'auto', 'on']);
    positions('cabin.noSmoking.set', 'cabin.noSmoking', ['off', 'auto', 'on']);
    const exit = pmdg ? 'lights.emergency' : 'cabin.emergencyExit';
    const armed = pmdg ? 'armed' : adapterId === 'fbw-a32nx' ? 'auto' : 'arm';
    positions('cabin.emergencyExit.set', exit, ['off', armed === 'auto' ? 'auto' : 'arm', 'on'], ['off', armed, 'on']);
  }
  if (pmdg || airbus || standard || ['fbw-a380x', 'inibuilds-a350'].includes(adapterId)) onOff('lights.wing.set', 'lights.wing');
  if (pmdg || standard || ['fbw-a32nx', 'fbw-a380x'].includes(adapterId)) onOff('lights.logo.set', 'lights.logo');
  if (adapterId === 'inibuilds-tristar') {
    for (const light of ['wing', 'logo']) onOff(`lights.${light}.set`, `lights.${light}`, 'setOff', 'setOn');
  }

  // These routes were already on the aircraft panels. Generic fallback was
  // disabled, so copying the generic catalogue made their voice commands vanish.
  if (standard || adapterId === 'fbw-a380x') {
    positions('surfaces.gear.set', 'controls.gear', ['up', 'down']);
    positions('surfaces.flaps.adjust', 'controls.flaps', ['increase', 'decrease']);
    onOff('surfaces.parkingBrake.set', 'controls.parkingBrake', standard ? 'off' : 'released', standard ? 'on' : 'set');
  }
  if (standard) {
    for (const [command, prefix] of [
      ['autopilot', 'apMaster'], ['flightDirector', 'flightDirector'], ['autothrottleArm', 'autothrottleArmed'],
      ['speedHold', 'speedHold'], ['headingHold', 'headingHold'], ['altitudeHold', 'altitudeHold'],
      ['verticalSpeedHold', 'verticalSpeedHold'], ['navHold', 'navHold'], ['approach', 'approachHold'],
    ]) onOff(`flightGuidance.${command}.set`, `flightGuidance.${prefix}`);
    if (adapterId === 'microsoft-737-max-8') onOff('flightGuidance.flightLevelChange.set', 'flightGuidance.flightLevelChange');
    for (const [target, min, max, step, units] of [
      ['speed', 100, 399, 1, 'knots'], ['heading', 0, 359, 1, 'degrees'],
      ['altitude', 0, 49000, 100, 'feet'], ['verticalSpeed', -6000, 6000, 100, 'feet-per-minute'],
    ] as const) number(`flightGuidance.${target}.set`, `flightGuidance.${target}.set`, min, max, step, units);
  }
  if (adapterId === 'fbw-a380x') {
    onOff('flightGuidance.autopilot1.set', 'flightGuidance.ap1');
    for (const target of ['autothrust', 'localizer', 'approach']) onOff(`flightGuidance.${target}.set`, `flightGuidance.${target}`);
    onOff('surfaces.spoilersArmed.set', 'controls.spoilersArmed');
    choose('surfaces.spoilers.set', Object.fromEntries([['retracted', 0], ['half', 0.5], ['full', 1]].map(([name, value]) =>
      [name, { ...action('controls.spoilers.set'), value }])));
    positions('propulsion.throttleDetent.set', 'propulsion.throttle', ['idle', 'climb', 'flex', 'toga'], ['idle', 'climb', 'flexMct', 'toga']);
  }
  if (adapterId === 'pmdg-737') {
    onOff('lights.beacon.set', 'lights.beacon');
    onOff('lights.wheelWell.set', 'lights.wheelWell');
    positions('lights.positionMode.set', 'lights.position', ['off', 'steady', 'strobe'], ['off', 'steady', 'strobeSteady']);
    for (const [command, id] of [['lnav', 'lnav'], ['vnav', 'vnav'], ['autopilot2', 'cmdB'], ['speed', 'speed'], ['n1', 'n1']])
      fixed(`flightGuidance.${command}.engage`, `afds.${id}.engage`);
    onOff('flightGuidance.autothrottleArm.set', 'afds.autothrottleArm');
    for (const side of ['Captain', 'FirstOfficer']) {
      onOff(`flightGuidance.flightDirector${side}.set`, `afds.flightDirector${side}`);
      number(`flightGuidance.course.${side === 'Captain' ? 'captain' : 'firstOfficer'}`, `mcp.course${side}.set`, 0, 359, 1, 'degrees');
    }
    onOff('surfaces.yawDamper.set', 'flightControls.yawDamper');
    onOff('systems.apuMaster.set', 'systems.apu');
    positions('systems.apuBleed.set', 'systems.air.apuBleed', ['off', 'on']);
    positions('systems.wingAntiIce.set', 'systems.ice.wing', ['off', 'on']);
    onOff('systems.externalPower.set', 'systems.electrical.groundPower', 'disconnect', 'connect');
  }
  if (adapterId === 'pmdg-777') {
    onOff('systems.apuMaster.set', 'systems.apuSelector');
    onOff('systems.apuGenerator.set', 'systems.electrical.apuGenerator');
    positions('systems.apuBleed.set', 'systems.air.apuBleed', ['off', 'auto']);
    positions('systems.wingAntiIce.set', 'systems.antiIce.wing', ['off', 'auto', 'on']);
    for (const side of ['captain', 'firstOfficer']) positions(`navigation.${side}.mode`, `efis.${side}.mapMode`, ['approach', 'vor', 'map', 'plan']);
  }
  if (pmdg) {
    for (const [index, side] of [[1, 'Left'], [2, 'Right']] as const) {
      positions(`systems.pack${index}.set`, `systems.air.pack${side}`, adapterId === 'pmdg-737' ? ['off', 'auto', 'high'] : ['off', 'auto']);
      positions(`systems.engineBleed${index}.set`, `systems.air.engineBleed${side}`, adapterId === 'pmdg-737' ? ['off', 'on'] : ['off', 'auto']);
      positions(`systems.engineAntiIce${index}.set`, `systems.${adapterId === 'pmdg-737' ? 'ice' : 'antiIce'}.engine${side}`,
        adapterId === 'pmdg-737' ? ['off', 'on'] : ['off', 'auto', 'on']);
      positions(`visibility.${index === 1 ? 'captain' : 'firstOfficer'}.wiper`, `visibility.wiper${side}`, ['off', 'intermittent', 'low', 'high']);
    }
  }
  if (airbus) {
    onOff('systems.apuMaster.set', 'systems.apuMaster');
    positions('systems.apuBleed.set', 'systems.apuBleed', ['off', 'on']);
    positions('systems.wingAntiIce.set', 'systems.wingAntiIce', ['off', 'on']);
    positions('systems.probeHeat.set', adapterId === 'fenix-a32x' ? 'systems.probeHeat' : 'systems.probeWindowHeat', ['auto', 'on']);
    positions('systems.crossBleed.set', 'systems.crossBleed', ['closed', 'auto', 'open'], adapterId === 'fenix-a32x' ? ['shut', 'auto', 'open'] : undefined);
    positions('systems.packFlow.set', 'systems.packFlow', ['low', 'normal', 'high']);
    for (const target of ['ramAir', 'brakeFan']) onOff(`systems.${target}.set`, `systems.${target}`);
    for (const index of [1, 2]) {
      for (const target of ['engineAntiIce', 'engineBleed', 'pack']) positions(`systems.${target}${index}.set`, `systems.${target}${index}`, ['off', 'on']);
      positions(`systems.battery${index}.set`, `systems.battery${index}`, ['off', 'auto']);
    }
    if (adapterId === 'fenix-a32x') {
      onOff('systems.apuGenerator.set', 'systems.apuGenerator');
      for (const side of ['Captain', 'FirstOfficer']) positions(`visibility.${side === 'Captain' ? 'captain' : 'firstOfficer'}.wiper`, `visibility.wiper${side}`, ['off', 'slow', 'fast']);
    } else {
      onOff('systems.externalPower.set', 'systems.externalPower');
      for (const side of ['Captain', 'FirstOfficer']) {
        const commandSide = side === 'Captain' ? 'captain' : 'firstOfficer';
        onOff(`navigation.${commandSide}.terrain`, `navigation.terrain${side}`);
        positions(`navigation.${commandSide}.mode`, `navigation.nd${side}Mode`, ['ils', 'vor', 'nav', 'arc', 'plan'], ['roseIls', 'roseVor', 'roseNav', 'arc', 'plan']);
      }
    }
  }
  if (adapterId === 'inibuilds-a350') {
    positions('lights.logoMode.set', 'lights.logo', ['off', 'auto', 'on']);
    positions('cabin.noMobile.set', 'cabin.noMobile', ['off', 'auto', 'on']);
    onOff('flightGuidance.flightDirector.set', 'flightGuidance.flightDirector');
    onOff('flightGuidance.metricAltitude.set', 'flightGuidance.metricAltitude');
    for (const side of ['Captain', 'FirstOfficer']) onOff(`flightGuidance.${side === 'Captain' ? 'captain' : 'firstOfficer'}.verticalView`, `flightGuidance.verticalView${side}`);
    onOff('systems.apuMaster.set', 'systems.apuMaster');
    onOff('systems.ramAir.set', 'systems.ramAir');
    positions('systems.wingAntiIce.set', 'systems.wingAntiIce', ['off', 'on']);
    positions('systems.probeHeat.set', 'systems.probeWindowHeat', ['auto', 'on']);
    positions('systems.crossBleed.set', 'systems.crossBleed', ['closed', 'auto', 'open']);
    positions('systems.packFlow.set', 'systems.airFlow', ['manual', 'low', 'normal', 'high']);
  }
  return bindings;
}
