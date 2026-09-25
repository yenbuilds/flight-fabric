'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Runtime builds, native tests and the replay driver must discover the same
// installed toolchain, including PATH fallback when a configured home is stale.
function resolveCargo({ env = process.env, platform = process.platform, existsSync = fs.existsSync } = {}) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const names = windows ? ['cargo.exe', 'cargo.cmd', 'cargo'] : ['cargo'];
  const dirs = [];
  if (env.CARGO_HOME) dirs.push(paths.join(env.CARGO_HOME, 'bin'));
  for (const home of [env.USERPROFILE, env.HOME]) {
    if (home) dirs.push(paths.join(home, '.cargo', 'bin'));
  }
  dirs.push(...String(env.PATH || '').split(paths.delimiter).filter(Boolean));
  const seen = new Set();
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = paths.join(dir, name);
      const key = windows ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      if (existsSync(candidate)) return candidate;
    }
  }
  return names[0];
}

module.exports = { resolveCargo };
