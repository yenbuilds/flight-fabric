const NULL_ISLAND_EPSILON_DEG = 1e-6;

export function isValidCoord(lat, lon) {
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return false;
  if (Math.abs(latNum) > 90 || Math.abs(lonNum) > 180) return false;
  return !(Math.abs(latNum) <= NULL_ISLAND_EPSILON_DEG && Math.abs(lonNum) <= NULL_ISLAND_EPSILON_DEG);
}
