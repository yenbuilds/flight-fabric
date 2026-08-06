export const RELEASE_LABEL = 'Alpha';
export const RELEASE_WARNING = 'Experimental release. Use with care.';

// Backwards-compatible aliases for callers that have not been renamed yet.
export const BETA_LABEL = RELEASE_LABEL;
export const BETA_WARNING = RELEASE_WARNING;

export function formatReleaseVersion(version) {
  const trimmed = String(version || '').trim();
  if (!trimmed) return '';
  const withoutLeadingV = trimmed.replace(/^v/i, '').trim();
  return /\b(alpha|beta|rc|public alpha)\b/i.test(withoutLeadingV) ? `v${withoutLeadingV}` : `v${withoutLeadingV} ${RELEASE_LABEL}`;
}

export const formatBetaVersion = formatReleaseVersion;
