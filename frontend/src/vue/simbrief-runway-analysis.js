function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function fieldsByKey(fields) {
  return new Map((Array.isArray(fields) ? fields : []).map((field) => [
    normalizeKey(field?.key),
    field?.value,
  ]));
}

function fieldValue(fields, ...keys) {
  const values = fields instanceof Map ? fields : fieldsByKey(fields);
  for (const key of keys) {
    const value = values.get(normalizeKey(key));
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return null;
}

function normalizeRunwayIdentifier(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/^RWY\s*/i, '')
    .replace(/\s+/g, '')
    .replace(/^0(?=\d[A-Z]?$)/, '');
}

function selectPlannedRunway(section, plannedRunway) {
  const runways = Array.isArray(section?.runways) ? section.runways : [];
  const plannedIdentifier = normalizeRunwayIdentifier(plannedRunway);
  if (plannedIdentifier) {
    return runways.find((runway) => normalizeRunwayIdentifier(
      fieldValue(runway, 'identifier', 'runway', 'runway_identifier'),
    ) === plannedIdentifier) || null;
  }
  return runways.length === 1 ? runways[0] : null;
}

function formatNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : String(value);
}

function joinParts(parts) {
  return parts.filter(Boolean).join(' · ') || null;
}

function labeledValue(label, value, suffix = '') {
  return value === null || value === undefined || value === ''
    ? null
    : `${label} ${value}${suffix}`;
}

function addRow(rows, key, label, value) {
  if (value) rows.push({ key, label, value });
}

function selectLandingDistanceReport(section, surfaceCondition) {
  const reports = Array.isArray(section?.distanceReports) ? section.distanceReports : [];
  if (!reports.length) return null;
  const surface = normalizeKey(surfaceCondition);
  const preferredCondition = surface.includes('dry') ? 'dry' : 'wet';
  return reports.find((report) => normalizeKey(report?.condition) === preferredCondition)
    || reports.find((report) => normalizeKey(report?.condition) === 'dry')
    || reports[0];
}

function buildCommonRows(conditions, runway, rows) {
  const plannedWeight = fieldValue(conditions, 'planned_weight');
  const surface = fieldValue(conditions, 'surface_condition');
  const windDirection = fieldValue(conditions, 'wind_direction');
  const windSpeed = fieldValue(conditions, 'wind_speed');
  const temperature = fieldValue(conditions, 'temperature');
  const altimeter = fieldValue(conditions, 'altimeter');

  addRow(rows, 'surface', 'Surface', surface);
  addRow(rows, 'wind', 'Wind', joinParts([
    windDirection ? `${windDirection}°` : null,
    windSpeed ? `${windSpeed} kt` : null,
  ]));
  addRow(rows, 'weather', 'OAT / altimeter', joinParts([
    temperature ? `${temperature}°` : null,
    altimeter,
  ]));
  addRow(rows, 'wind-components', 'Wind components', joinParts([
    labeledValue('HW', fieldValue(runway, 'headwind_component'), ' kt'),
    labeledValue('XW', fieldValue(runway, 'crosswind_component'), ' kt'),
  ]));

  return { plannedWeight, surface };
}

function buildTakeoffRows(conditions, runway) {
  const rows = [];
  const { plannedWeight } = buildCommonRows(conditions, runway, rows);
  const maxWeight = fieldValue(runway, 'max_weight');

  rows.unshift({
    key: 'weight',
    label: 'Weight (planned / max)',
    value: joinParts([
      labeledValue('Planned', formatNumber(plannedWeight)),
      labeledValue('Max', formatNumber(maxWeight)),
    ]) || '--',
  });
  addRow(rows, 'runway-available', 'Runway available', joinParts([
    labeledValue('TORA', formatNumber(fieldValue(runway, 'length_tora'))),
    labeledValue('ASDA', formatNumber(fieldValue(runway, 'length_asda'))),
  ]));
  addRow(rows, 'configuration', 'Configuration', joinParts([
    labeledValue('Flaps', fieldValue(runway, 'flap_setting')),
    labeledValue('Thrust', fieldValue(runway, 'thrust_setting')),
    labeledValue('FLEX', fieldValue(runway, 'flex_temperature'), '°'),
  ]));
  addRow(rows, 'speeds', 'V speeds', joinParts([
    labeledValue('V1', fieldValue(runway, 'speeds_v1')),
    labeledValue('VR', fieldValue(runway, 'speeds_vr')),
    labeledValue('V2', fieldValue(runway, 'speeds_v2')),
  ]));
  addRow(rows, 'distance-required', 'Required distance', joinParts([
    labeledValue('GO', formatNumber(fieldValue(runway, 'distance_continue'))),
    labeledValue('STOP', formatNumber(fieldValue(runway, 'distance_reject'))),
  ]));
  addRow(rows, 'distance-margin', 'Runway margin', formatNumber(fieldValue(runway, 'distance_margin')));
  return rows;
}

function buildLandingRows(section, conditions, runway) {
  const rows = [];
  const { plannedWeight, surface } = buildCommonRows(conditions, runway, rows);
  const distanceReport = selectLandingDistanceReport(section, surface);
  const distanceFields = fieldsByKey(distanceReport?.fields);
  const condition = normalizeKey(distanceReport?.condition);
  const maxWeight = condition === 'wet'
    ? fieldValue(runway, 'max_weight_wet', 'max_weight_dry')
    : fieldValue(runway, 'max_weight_dry', 'max_weight_wet');

  rows.unshift({
    key: 'weight',
    label: 'Weight (planned / max)',
    value: joinParts([
      labeledValue('Planned', formatNumber(plannedWeight)),
      labeledValue('Max', formatNumber(maxWeight)),
    ]) || '--',
  });
  addRow(rows, 'runway-available', 'Runway available', labeledValue(
    'LDA',
    formatNumber(fieldValue(runway, 'length_lda')),
  ));
  addRow(rows, 'configuration', 'Configuration', joinParts([
    labeledValue('Flaps', fieldValue(distanceFields, 'flap_setting') || fieldValue(conditions, 'flap_setting')),
    labeledValue('Brakes', fieldValue(distanceFields, 'brake_setting')),
    labeledValue('Reverse', fieldValue(distanceFields, 'reverser_credit')),
  ]));
  addRow(rows, 'vref', 'VREF', fieldValue(distanceFields, 'speeds_vref'));
  addRow(rows, 'landing-distance', `Landing distance${condition ? ` (${condition})` : ''}`, joinParts([
    labeledValue('Actual', formatNumber(fieldValue(distanceFields, 'actual_distance'))),
    labeledValue('Factored', formatNumber(fieldValue(distanceFields, 'factored_distance'))),
  ]));
  return rows;
}

export function buildRunwayAnalysisSection(kind, section) {
  if (!section) return null;
  const conditions = fieldsByKey(section.conditions);
  const airport = fieldValue(conditions, 'airport_icao');
  const plannedRunway = fieldValue(conditions, 'planned_runway');
  const runwayFields = selectPlannedRunway(section, plannedRunway);
  const runway = fieldsByKey(runwayFields);
  const normalizedKind = normalizeKey(kind);
  const rows = normalizedKind === 'landing'
    ? buildLandingRows(section, conditions, runway)
    : buildTakeoffRows(conditions, runway);

  return {
    key: normalizedKind,
    label: normalizedKind === 'landing' ? 'Landing' : 'Takeoff',
    location: joinParts([
      airport,
      plannedRunway ? `RWY ${plannedRunway}` : null,
    ]),
    rows: rows.filter((row) => row.value && row.value !== '--'),
  };
}

export function buildRunwayAnalysisSections(tlr) {
  return [
    buildRunwayAnalysisSection('takeoff', tlr?.takeoff),
    buildRunwayAnalysisSection('landing', tlr?.landing),
  ].filter((section) => section?.rows?.length);
}
