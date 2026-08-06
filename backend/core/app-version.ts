const APP_RELEASE_CHANNEL = 'Alpha';
const APP_RELEASE_WARNING = 'Experimental release. Use with care.';

type VersionedPackage = {
  version?: string;
};

function readVersion(relativePath: string): string | null {
  try {
    const pkg = require(relativePath) as VersionedPackage;
    return pkg && typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function getAppVersion(): string | null {
  return readVersion('../../package.json') || readVersion('../package.json') || null;
}

function formatDisplayVersion(version: string | null | undefined): string | null {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim();
  if (!trimmed) return null;
  return /\b(alpha|beta|rc|public alpha)\b/i.test(trimmed) ? trimmed : `${trimmed} ${APP_RELEASE_CHANNEL}`;
}

function getDisplayAppVersion(): string | null {
  return formatDisplayVersion(getAppVersion());
}

export {
  APP_RELEASE_CHANNEL,
  APP_RELEASE_WARNING,
  formatDisplayVersion,
  getAppVersion,
  getDisplayAppVersion,
};
