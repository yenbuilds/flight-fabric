export function getFlightRouteLabel(flight) {
  if (!flight || typeof flight !== 'object') return '';
  return String(flight.displayRouteLabel || flight.route || flight.flightId || '');
}

function getFlightRouteSortLabel(flight) {
  if (!flight || typeof flight !== 'object') return '';
  return String(flight.displayRouteLabel || flight.route || '').trim();
}

export function getFlightAircraftLabel(flight) {
  if (!flight || typeof flight !== 'object') return '';
  return String(flight.aircraft || '').trim();
}

export function getFlightBundleSizeBytes(flight) {
  if (!flight || typeof flight !== 'object') return null;
  for (const value of [flight.recordingBundleSizeBytes, flight.sizeBytes]) {
    if (value === null || value === undefined || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

const TEXT_SORT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export function sortAndFilterFlights(flights, filters = {}, helpers = {}) {
  const routeFilter = normalizeSearch(filters.route);
  const aircraftFilter = normalizeSearch(filters.aircraft);
  const getFiniteFuelBurnGal = helpers.getFiniteFuelBurnGal || ((value) => Number.isFinite(Number(value)) ? Number(value) : null);

  const filtered = (Array.isArray(flights) ? flights : []).filter((flight) => {
    const routeText = normalizeSearch(getFlightRouteLabel(flight));
    const aircraftText = normalizeSearch(getFlightAircraftLabel(flight));
    return (!routeFilter || routeText.includes(routeFilter))
      && (!aircraftFilter || aircraftText.includes(aircraftFilter));
  });

  const compareFuel = (a, b, direction = 'asc') => {
    const aNum = getFiniteFuelBurnGal(a);
    const bNum = getFiniteFuelBurnGal(b);
    const aFinite = aNum !== null;
    const bFinite = bNum !== null;
    if (!aFinite && !bFinite) return 0;
    if (!aFinite) return 1;
    if (!bFinite) return -1;
    return direction === 'desc' ? bNum - aNum : aNum - bNum;
  };

  filtered.sort((a, b) => {
    switch (filters.sort || 'recent') {
      case 'oldest':
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      case 'fuel_burn_desc':
        return compareFuel(a.fuelBurnGal, b.fuelBurnGal, 'desc') || recentSort(a, b);
      case 'fuel_burn_asc':
        return compareFuel(a.fuelBurnGal, b.fuelBurnGal, 'asc') || recentSort(a, b);
      case 'route':
        return compareFlightText(getFlightRouteSortLabel(a), getFlightRouteSortLabel(b)) || recentSort(a, b);
      case 'aircraft':
        return compareFlightText(getFlightAircraftLabel(a), getFlightAircraftLabel(b))
          || compareFlightText(getFlightRouteSortLabel(a), getFlightRouteSortLabel(b))
          || recentSort(a, b);
      case 'recent':
      default:
        return recentSort(a, b);
    }
  });

  return filtered;
}

function normalizeSearch(value) {
  return String(value || '').trim().toLowerCase();
}

function compareFlightText(left, right) {
  const normalizedLeft = normalizeSearch(left);
  const normalizedRight = normalizeSearch(right);
  if (!normalizedLeft && !normalizedRight) return 0;
  if (!normalizedLeft) return 1;
  if (!normalizedRight) return -1;

  const normalizedComparison = TEXT_SORT_COLLATOR.compare(normalizedLeft, normalizedRight);
  if (normalizedComparison !== 0) return normalizedComparison;

  return TEXT_SORT_COLLATOR.compare(String(left || '').trim(), String(right || '').trim());
}

function recentSort(a, b) {
  return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
}
