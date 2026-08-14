const CARDINAL_DIRECTIONS = [
  'N', 'NNE', 'NE', 'ENE',
  'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW',
  'W', 'WNW', 'NW', 'NNW',
];

function finiteNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const numeric = finiteNumber(value);
    if (numeric != null) return numeric;
  }
  return null;
}

export function normalizeWindDirectionDegrees(value) {
  const numeric = finiteNumber(value);
  if (numeric == null) return null;
  return ((numeric % 360) + 360) % 360;
}

export function buildLandingWindPresentation(input = {}) {
  const directionDeg = normalizeWindDirectionDegrees(firstFiniteNumber(
    input.windDirectionTrueDeg,
    input.windDirectionDeg,
    input.windDirDeg,
    input.wind_dir_deg,
  ));
  const rawSpeedKts = firstFiniteNumber(input.windSpeed, input.windSpeedKts, input.wind_speed_kts);
  const speedKts = rawSpeedKts != null && rawSpeedKts >= 0 ? rawSpeedKts : null;
  const crosswindKts = firstFiniteNumber(input.crosswind, input.xwindKts, input.xwind_kts);
  const roundedCrosswindKts = crosswindKts == null ? null : Math.round(Math.abs(crosswindKts));
  const calm = speedKts != null && speedKts < 0.5;

  const roundedDirectionDeg = directionDeg == null ? null : Math.round(directionDeg) % 360;
  const displayDirectionDeg = roundedDirectionDeg === 0 ? 360 : roundedDirectionDeg;
  const directionText = displayDirectionDeg == null
    ? 'DIR --'
    : `${String(displayDirectionDeg).padStart(3, '0')}°T`;
  const speedText = speedKts == null ? '-- kt' : `${Math.round(speedKts)} kt`;
  const cardinalText = directionDeg == null
    ? ''
    : CARDINAL_DIRECTIONS[Math.floor((directionDeg + 11.25) / 22.5) % CARDINAL_DIRECTIONS.length];

  let crosswindText = '-- kt';
  let crosswindDetailText = 'Crosswind unavailable';
  if (crosswindKts != null) {
    if (roundedCrosswindKts === 0) {
      crosswindText = '0 kt';
      crosswindDetailText = 'No crosswind';
    } else {
      const sideShort = crosswindKts > 0 ? 'R' : 'L';
      const sideLong = crosswindKts > 0 ? 'right' : 'left';
      crosswindText = `${roundedCrosswindKts} kt ${sideShort}`;
      crosswindDetailText = `XW ${roundedCrosswindKts} kt from ${sideLong}`;
    }
  }

  if (calm) {
    return {
      available: true,
      calm: true,
      directionDeg,
      speedKts,
      crosswindKts,
      directionPrefixText: '',
      directionText: 'CALM',
      speedText,
      cardinalText: '',
      arrowVisible: false,
      arrowRotationDeg: 0,
      crosswindText: '0 kt',
      crosswindDetailText: 'No crosswind',
      totalText: `CALM · ${speedText}`,
      ariaLabel: `Wind at touchdown, calm at ${Math.round(speedKts)} knots`,
    };
  }

  const directionSummary = directionDeg == null ? 'Direction unavailable' : `FROM ${directionText}`;
  const speedSummary = speedKts == null ? 'speed unavailable' : speedText;
  const ariaDirection = directionDeg == null
    ? 'direction unavailable'
    : `from ${displayDirectionDeg} degrees true${cardinalText ? `, ${cardinalText}` : ''}`;
  const crosswindOnlySummary = crosswindKts == null
    ? null
    : roundedCrosswindKts === 0
      ? 'No crosswind'
      : `From ${crosswindKts > 0 ? 'right' : 'left'}`;
  const totalText = directionDeg == null && speedKts == null && crosswindOnlySummary
    ? crosswindOnlySummary
    : `${directionSummary} · ${speedSummary}`;
  const ariaSpeed = speedKts == null ? 'speed unavailable' : `${Math.round(speedKts)} knots`;
  const ariaCrosswind = crosswindKts == null
    ? ''
    : roundedCrosswindKts === 0
      ? ', no crosswind'
      : `, crosswind ${roundedCrosswindKts} knots from ${crosswindKts > 0 ? 'right' : 'left'}`;

  return {
    available: directionDeg != null || speedKts != null || crosswindKts != null,
    calm: false,
    directionDeg,
    speedKts,
    crosswindKts,
    directionPrefixText: directionDeg == null ? '' : 'FROM',
    directionText,
    speedText,
    cardinalText,
    arrowVisible: directionDeg != null,
    arrowRotationDeg: directionDeg ?? 0,
    crosswindText,
    crosswindDetailText,
    totalText,
    ariaLabel: `Wind at touchdown, ${ariaDirection}, ${ariaSpeed}${ariaCrosswind}`,
  };
}
