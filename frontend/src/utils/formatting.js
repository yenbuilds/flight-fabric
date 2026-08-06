const LBS_TO_KG = 0.453592;

export function formatBytes(bytes) {
  const numericValue = Number(bytes);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let value = numericValue;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatDuration(ms) {
  const totalSec = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(totalSec) || totalSec < 0) return '--';

  const hr = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (hr > 0) {
    return `${hr}h ${min}m`;
  }
  return `${min}m ${sec}s`;
}

export function getFiniteFuelBurnGal(value) {
  if (value === null || value === undefined || value === '') return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 1 ? numericValue : null;
}

export function getFiniteDistanceNm(value) {
  if (value === null || value === undefined || value === '') return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0.05 ? numericValue : null;
}

export function formatDistanceNm(value) {
  const distanceNm = getFiniteDistanceNm(value);
  if (distanceNm === null) return '--';

  const roundedNm = distanceNm < 10
    ? Math.round(distanceNm * 10) / 10
    : Math.round(distanceNm);
  return `${roundedNm.toLocaleString(undefined, {
    minimumFractionDigits: distanceNm < 10 ? 1 : 0,
    maximumFractionDigits: distanceNm < 10 ? 1 : 0,
  })} NM`;
}

export function formatFuelBurn(gal, unit = 'gal', weightLbs = null) {
  const fuelGal = getFiniteFuelBurnGal(gal);
  const numericWeightLbs = Number(weightLbs);
  const hasWeight = Number.isFinite(numericWeightLbs) && numericWeightLbs > 10;

  if (unit === 'lbs') {
    return hasWeight ? `${Math.round(numericWeightLbs).toLocaleString()} lbs` : '--';
  }
  if (unit === 'kg') {
    return hasWeight ? `${Math.round(numericWeightLbs * LBS_TO_KG).toLocaleString()} kg` : '--';
  }
  if (fuelGal === null) return '--';

  const roundedGal = Math.round(fuelGal * 10) / 10;
  const hasDecimal = Math.abs(roundedGal - Math.round(roundedGal)) > 0.001;
  return `${roundedGal.toLocaleString(undefined, {
    minimumFractionDigits: hasDecimal ? 1 : 0,
    maximumFractionDigits: 1,
  })} gal`;
}
