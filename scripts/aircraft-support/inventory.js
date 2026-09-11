'use strict';

const crypto = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function profileKey(value) {
  const key = value?.includes('/') ? value : `bundled/msfs/${value || ''}`;
  if (!/^bundled\/(msfs|xplane)\/[a-z0-9][a-z0-9-]*$/.test(key)) {
    throw new Error('Use an exact bundled profile, for example bundled/msfs/pmdg-737.');
  }
  return key;
}

function buildReport({ profile, integration, catalogue, sourceProfiles, generatedAt = new Date().toISOString() }) {
  const commands = [...catalogue.inventory].sort((a, b) => a.id.localeCompare(b.id));
  const fields = Object.values(integration?.fields || {}).sort((a, b) => a.id.localeCompare(b.id));
  const actions = Object.values(integration?.actions || {}).sort((a, b) => a.id.localeCompare(b.id))
    .map(action => ({ ...action, commandIds: commands.filter(command => command.actionIds?.includes(action.id))
      .map(command => command.id) }));
  const contract = {
    profileKey: profile._profileKey,
    integrationId: integration?.id || null,
    trustedProfileKeys: integration?.trustedProfileKeys || [],
    profileDefinitions: sourceProfiles.map(({ key, document }) => ({ key, document })),
    fields, actions, commands,
  };
  const counts = {
    fields: fields.length, actions: actions.length,
    advertisedCommands: commands.filter(command => command.supported).length,
    unavailableCommands: commands.filter(command => !command.supported).length,
    actionsOutsideCommandCatalogue: actions.filter(action => !action.commandIds.length).length,
    declaredVerification: Object.fromEntries(['untested', 'partial', 'verified'].map(status =>
      [status, actions.filter(action => action.verification === status).length])),
  };
  return {
    schemaVersion: 1, kind: 'aircraft-support-report', generatedAt,
    profileName: profile.name, contractHash: fingerprint(contract), counts,
    scope: 'Static implementation inventory with all supported transports assumed available. No live aircraft verification.',
    sources: sourceProfiles.map(({ key, document }) => ({ profileKey: key,
      verification: document.provenance?.verification || null,
      sources: document.provenance?.sources || [] })),
    contract,
  };
}

function readbacks(route) {
  return route.readbacks || (route.readback ? [route.readback] : []);
}

function observationDependencies(value, result = new Set()) {
  if (!value || typeof value !== 'object') return result;
  if (typeof value.fieldId === 'string') result.add(value.fieldId);
  for (const child of Object.values(value)) observationDependencies(child, result);
  return result;
}

function buildValidationPlan(report) {
  return {
    schemaVersion: 1, kind: 'aircraft-validation-plan', profileKey: report.contract.profileKey,
    contractHash: report.contractHash,
    instructions: [
      'Choose one action and route; establish its vendor source and the installed aircraft/simulator versions.',
      'Use a suitable simulator starting state. Observe both the cockpit and Flight Fabric readback.',
      'Capture a changed target and an already-satisfied target separately. Test numeric boundaries only in a suitable setup.',
      'Record unavailable/stale-source behavior and interrupted actions. Do not infer cockpit success from transport acceptance.',
      'Logical-state captures do not record raw SDK packets or command results and cannot validate decoding or write delivery.',
    ],
    cases: report.contract.actions.flatMap(action => action.routes.map(route => ({
      id: `${action.id}/${route.id}`, actionId: action.id, routeId: route.id, transport: route.transport,
      declaredVerification: action.verification, commandIds: action.commandIds,
      input: action.input || null, guard: action.guard,
      preconditions: route.preconditions || (route.precondition ? [route.precondition] : []),
      confirmation: route.confirmation === 'transport-acknowledged' ? 'transport-acknowledged'
        : readbacks(route).length ? 'observed-readback' : 'no-declared-readback',
      expectedReadbacks: readbacks(route),
      observationFields: [...observationDependencies({ route, guard: action.guard })].sort(),
      result: 'not-run', aircraftVersion: null, simulatorVersion: null,
      startingState: null, cockpitObservation: null, commandResult: null, captureFile: null,
    }))),
  };
}

function assertReport(report) {
  if (report?.schemaVersion !== 1 || report.kind !== 'aircraft-support-report'
    || !report.contract || fingerprint(report.contract) !== report.contractHash) {
    throw new Error('Invalid report or contract hash mismatch. Generate a fresh aircraft support report.');
  }
  for (const name of ['fields', 'actions', 'commands']) {
    const items = report.contract[name];
    if (!Array.isArray(items) || items.some(item => typeof item?.id !== 'string')
      || new Set(items.map(item => item.id)).size !== items.length) throw new Error(`Invalid ${name} inventory.`);
  }
}

function diffReports(before, after) {
  assertReport(before); assertReport(after);
  if (before.contract.profileKey !== after.contract.profileKey) throw new Error('Compare reports for the same exact profile.');
  const changes = {};
  for (const name of ['fields', 'actions', 'commands']) {
    const oldItems = new Map(before.contract[name].map(item => [item.id, item]));
    const newItems = new Map(after.contract[name].map(item => [item.id, item]));
    changes[name] = {
      added: [...newItems.keys()].filter(id => !oldItems.has(id)).sort(),
      removed: [...oldItems.keys()].filter(id => !newItems.has(id)).sort(),
      changed: [...newItems.keys()].filter(id => oldItems.has(id)
        && fingerprint(oldItems.get(id)) !== fingerprint(newItems.get(id))).sort(),
    };
  }
  const changedFields = new Set([...changes.fields.added, ...changes.fields.changed, ...changes.fields.removed]);
  const affectedActions = new Set([...changes.actions.added, ...changes.actions.changed]);
  const changedCommands = new Set([...changes.commands.added, ...changes.commands.changed, ...changes.commands.removed]);
  const currentActions = new Set(after.contract.actions.map(action => action.id));
  for (const command of [...before.contract.commands, ...after.contract.commands]) {
    if (!changedCommands.has(command.id)) continue;
    for (const id of command.actionIds || []) if (currentActions.has(id)) affectedActions.add(id);
  }
  for (const action of after.contract.actions) {
    if ([...observationDependencies(action)].some(id => changedFields.has(id))) affectedActions.add(action.id);
  }
  return {
    schemaVersion: 1, kind: 'aircraft-support-diff', profileKey: after.contract.profileKey,
    beforeHash: before.contractHash, afterHash: after.contractHash,
    contractChanged: before.contractHash !== after.contractHash,
    profileDefinitionsChanged: fingerprint(before.contract.profileDefinitions) !== fingerprint(after.contract.profileDefinitions),
    changes, actionsToRecheck: [...affectedActions].sort(),
    note: 'Recheck suggestions use changed command bindings and declared observations. Review profile, provider, and cockpit behavior changes separately.',
  };
}

function cell(value) { return String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' '); }

function renderReport(report) {
  const { contract, counts } = report;
  const lines = [`# ${cell(report.profileName)} — integration report`, '', report.scope, '',
    `Profile: \`${contract.profileKey}\`  `, `Contract: \`${report.contractHash}\``, '',
    `${counts.fields} logical fields, ${counts.actions} actions, ${counts.advertisedCommands} advertised commands.`,
    `Declared action status: ${Object.entries(counts.declaredVerification).map(([key, value]) => `${value} ${key}`).join(', ')}.`,
    '', '## Commands', '', '| Command | Available with assumed transports | Actions | Voice patterns |', '| --- | --- | --- | --- |',
    ...contract.commands.map(command => `| ${cell(command.id)} | ${command.supported ? 'Yes' : 'No'} | ${cell(command.actionIds?.join(', '))} | ${cell(command.speech?.patterns?.join('; '))} |`),
    '', '## Actions and observations', '',
    'Actions outside the canonical command catalogue may have dedicated cockpit-page controls. Their absence here is not automatically a defect.', '',
    '| Action | Declared status | Commands | Routes and confirmation |', '| --- | --- | --- | --- |',
    ...contract.actions.map(action => `| ${cell(action.id)} | ${action.verification} | ${cell(action.commandIds.join(', '))} | ${cell(action.routes.map(route => `${route.id} (${route.transport}): ${route.confirmation || readbacks(route).map(item => item.fieldId).join(', ') || 'no declared readback'}`).join('; '))} |`),
    '', '## Telemetry fields', '', '| Field | Ordered sources | Decode semantics |', '| --- | --- | --- |',
    ...contract.fields.map(field => `| ${cell(field.id)} | ${cell(field.sources.map(source => JSON.stringify(source.route)).join('; '))} | ${cell(field.sources.map(source => JSON.stringify(source.decode)).join('; '))} |`),
    '', '## Declared provenance', '', 'These references come from the profile documents; this report does not independently verify their claims.', '',
    ...report.sources.flatMap(entry => [`### ${entry.profileKey}`, '', ...(entry.sources.length
      ? entry.sources.map(source => `- ${cell(source.name || source.type)}${source.url ? ` — ${cell(source.url)}` : ''}: ${cell(source.notes)}`)
      : ['No source entries declared in this profile.']), '']),
    '## Validation', '',
    'Use validation-plan.json to select exact actions, inputs, routes and required observations. Every generated case begins as not-run.',
    'Run the existing profile provenance, command matrix and affected provider/adapter tests. Capture simulator observations for each installed version before changing declared verification status.', '',
  ];
  return lines.join('\n');
}

module.exports = { profileKey, buildReport, buildValidationPlan, diffReports, renderReport };
