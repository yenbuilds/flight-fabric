export function parseRunwayHeadingFromId(runwayId: string | null | undefined): number {
  if (!runwayId) return 0;

  const match = String(runwayId).toUpperCase().match(/^(\d{1,2})/);
  if (!match) return 0;

  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;

  return ((value % 36) || 36) * 10;
}
