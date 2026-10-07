'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const { createRequire } = require('node:module');
const path = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');
const { ROOT, getRepoScratchPath } = require('../../scripts/repo-scratch');

const execFileAsync = promisify(execFile);
const electronRequire = createRequire(path.join(ROOT, 'electron/package.json'));
const builderRequire = createRequire(electronRequire.resolve('app-builder-lib/package.json'));

async function downloadChild() {
  // Resolve the downloader used by electron-builder, not Electron's separate
  // installer dependency. Proxy bootstrap changes globals, so isolate it here.
  const { downloadArtifact } = builderRequire('@electron/get');
  const { scratch, proxyURL, directURL } = JSON.parse(process.argv[3]);
  const bytes = Buffer.from('FlightFabric build download fixture\n');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const options = {
    isGeneric: true,
    version: '41.10.6',
    artifactName: 'fixture.zip',
    cacheRoot: path.join(scratch, 'cache'),
    tempDirectory: scratch,
    force: true,
    downloadOptions: { quiet: true, retry: { limit: 0 }, timeout: { request: 5000 } },
    checksums: { 'fixture.zip': checksum },
  };
  for (const url of [proxyURL, directURL]) {
    const result = await downloadArtifact({
      ...options,
      mirrorOptions: { resolveAssetURL: () => url },
    });
    assert.deepEqual(await fs.readFile(result), bytes);
  }
  await assert.rejects(downloadArtifact({
    ...options,
    checksums: { 'fixture.zip': '0'.repeat(64) },
    mirrorOptions: { resolveAssetURL: () => `${proxyURL}?bad-checksum` },
  }), /checksum/i, 'proxy downloads must retain checksum verification');
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

if (process.argv[2] === '--download-child') {
  downloadChild().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  for (const location of ['.', 'electron']) {
    test(`Tailwind and nested selectors remain compatible in ${location}`, async () => {
      const requireBuild = createRequire(path.join(ROOT, location, 'package.json'));
      const tailwind = requireBuild('tailwindcss');
      const requireTailwind = createRequire(requireBuild.resolve('tailwindcss'));
      const postcss = requireTailwind('postcss');
      const nested = requireTailwind('postcss-nested');
      const config = require('../../tailwind.config');
      const result = await postcss([nested(), tailwind({
        ...config,
        content: [{ raw: '<button class="px-3 hover:opacity-50 disabled:opacity-50 [&>svg]:h-4"></button>' }],
      })]).process(`
        @tailwind utilities;
        .control {
          @apply px-3;
          &[data-pending="true"] { @apply opacity-50; }
        }
      `, { from: undefined });
      const declarations = (selector) => {
        const values = {};
        result.root.walkRules(selector, rule => rule.walkDecls(decl => {
          values[decl.prop] = decl.value;
        }));
        return values;
      };
      assert.equal(declarations('.px-3')['padding-left'], '0.75rem');
      assert.equal(declarations('.hover\\:opacity-50:hover').opacity, '0.5');
      assert.equal(declarations('.disabled\\:opacity-50:disabled').opacity, '0.5');
      assert.equal(declarations('.\\[\\&\\>svg\\]\\:h-4>svg').height, '1rem');
      assert.equal(declarations('.control')['padding-right'], '0.75rem');
      assert.equal(declarations('.control[data-pending="true"]').opacity, '0.5');
      assert.equal(result.css.includes('@apply'), false);
    });
  }

  test('Electron builder downloads through its proxy, honors NO_PROXY and checks hashes', { timeout: 20000 }, async () => {
    const requests = { proxy: [], direct: [] };
    const respond = (route) => (request, response) => {
      requests[route].push(request.url);
      response.end('FlightFabric build download fixture\n');
    };
    const proxy = http.createServer(respond('proxy'));
    const origin = http.createServer(respond('direct'));
    const scratchRoot = getRepoScratchPath('build-dependency-tests');
    await fs.mkdir(scratchRoot, { recursive: true });
    const scratch = await fs.mkdtemp(path.join(scratchRoot, 'download-'));
    try {
      const proxyAddress = await listen(proxy);
      const directAddress = await listen(origin);
      const env = { ...process.env };
      // Ignore developer mirror/proxy settings so this check can only reach
      // loopback fixtures (or the deliberately unresolvable .invalid hostname).
      for (const key of Object.keys(env)) {
        if (/proxy|^global_agent_|^electron_(mirror|custom|nightly|download)|^npm_(config|package_config)_electron_/i.test(key)) delete env[key];
      }
      Object.assign(env, {
        ELECTRON_GET_USE_PROXY: 'true',
        ELECTRON_GET_NO_PROGRESS: '1',
        GLOBAL_AGENT_HTTP_PROXY: proxyAddress,
        GLOBAL_AGENT_NO_PROXY: '127.0.0.1',
      });
      const proxyURL = 'http://download.invalid/fixture.zip';
      await execFileAsync(process.execPath, [__filename, '--download-child', JSON.stringify({
        scratch,
        proxyURL,
        directURL: `${directAddress}/fixture.zip`,
      })], { env, windowsHide: true, timeout: 15000 });
      assert.deepEqual(requests.proxy, [proxyURL, `${proxyURL}?bad-checksum`]);
      assert.deepEqual(requests.direct, ['/fixture.zip']);
    } finally {
      await close(proxy);
      await close(origin);
      // mkdtemp created this exact child of our task scratch directory.
      assert.equal(path.dirname(scratch), scratchRoot);
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });
}
