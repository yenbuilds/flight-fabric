// The paired phone or tablet loads the app at /remote. Prompts that belong on
// the simulator PC (welcome, what's new, support) stay off that view so the
// same person is never asked twice.
export function isRemoteViewPath(pathname) {
  const normalized = String(pathname || '').toLowerCase();
  return normalized === '/remote' || normalized === '/remote.html';
}

export function isRemoteView(locationRef = globalThis.location) {
  return isRemoteViewPath(locationRef?.pathname);
}
