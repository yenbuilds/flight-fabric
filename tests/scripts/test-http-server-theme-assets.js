#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected=${expected} actual=${actual}`);
  }
}

function assertIncludes(actual, expected, message) {
  if (typeof actual !== 'string' || !actual.includes(expected)) {
    throw new Error(`${message}: expected to include ${JSON.stringify(expected)}`);
  }
}

function assertNotIncludes(actual, expected, message) {
  if (typeof actual === 'string' && actual.includes(expected)) {
    throw new Error(`${message}: expected not to include ${JSON.stringify(expected)}`);
  }
}

function assertBufferString(actual, expected, message) {
  if (!actual || actual.toString('utf8') !== expected) {
    throw new Error(`${message}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual ? actual.toString('utf8') : null)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected=${expectedJson} actual=${actualJson}`);
  }
}

function withTempHome(fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-http-theme-assets-'));
  const tempAppData = path.join(tmpRoot, 'AppData', 'Roaming');
  const tempXdgConfig = path.join(tmpRoot, '.config');

  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };

  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  process.env.APPDATA = tempAppData;
  process.env.XDG_CONFIG_HOME = tempXdgConfig;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  try {
    return fn(tmpRoot);
  } finally {
    if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
    if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
    if (prev.HOMEDRIVE === undefined) delete process.env.HOMEDRIVE; else process.env.HOMEDRIVE = prev.HOMEDRIVE;
    if (prev.HOMEPATH === undefined) delete process.env.HOMEPATH; else process.env.HOMEPATH = prev.HOMEPATH;
    if (prev.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev.APPDATA;
    if (prev.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function loadFreshModules() {
  const storagePathsModulePath = resolveBackendRuntimeFile('utils', 'storage-paths.js');
  const httpServerModulePath = resolveBackendRuntimeFile('core', 'http-server.js');
  delete require.cache[storagePathsModulePath];
  delete require.cache[httpServerModulePath];

  const storagePaths = require(storagePathsModulePath);
  const httpServer = require(httpServerModulePath);
  return { storagePaths, httpServer };
}

function requestText(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

function requestBuffer(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) });
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

async function run() {
  await withTempHome(async (tmpRoot) => {
    const { storagePaths, httpServer } = loadFreshModules();
    const simulatedPackagedModuleDir = path.join(tmpRoot, 'resources', 'backend', 'core');
    assertEqual(
      httpServer.resolvePackagedFrontendDir(simulatedPackagedModuleDir, true),
      path.join(tmpRoot, 'resources', 'frontend'),
      'packaged backend should resolve Electron frontend resources beside backend resources',
    );
    assertEqual(
      httpServer.resolvePackagedFrontendDir(simulatedPackagedModuleDir, false),
      null,
      'development backend should not invent a packaged frontend root',
    );
    const rankedIps = httpServer.getLocalIPsFromInterfaces({
      'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.17.32.1' }],
      WiFi: [{ family: 'IPv4', internal: false, address: '192.168.50.49' }],
      'Ethernet 2': [{ family: 'IPv4', internal: false, address: '169.254.83.107' }],
    });
    assertDeepEqual(
      rankedIps,
      ['192.168.50.49', '172.17.32.1', '169.254.83.107'],
      'local IP ranking should prefer real LAN addresses over virtual and link-local adapters',
    );
    assertEqual(
      httpServer.isTrustedHttpRequest(
        { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:8100' } },
        false,
      ),
      true,
      'loopback peer and Host should remain available when remote access is disabled',
    );
    assertEqual(
      httpServer.isTrustedHttpRequest(
        { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.example:8100' } },
        true,
      ),
      false,
      'public DNS-rebinding Host should be rejected even from a loopback peer',
    );
    assertEqual(
      httpServer.isTrustedHttpRequest(
        { socket: { remoteAddress: '192.168.50.4' }, headers: { host: '192.168.50.49:8100' } },
        true,
      ),
      true,
      'private peer and private Host should be accepted when remote access is enabled',
    );
    assertEqual(
      httpServer.isTrustedHttpRequest(
        { socket: { remoteAddress: '203.0.113.5' }, headers: { host: '192.168.50.49:8100' } },
        true,
      ),
      false,
      'public peer should not reach the trusted-LAN HTTP surface',
    );
    assertEqual(
      httpServer.isTrustedHttpRequest(
        { socket: { remoteAddress: '192.168.50.4' }, headers: { host: 'localhost:8100' } },
        true,
      ),
      false,
      'private peer should not be able to claim a loopback Host',
    );
    assertEqual(
      httpServer.isTrustedHttpRequest(
        { socket: { remoteAddress: '192.168.50.4' }, headers: { host: '10.attacker.example:8100' } },
        true,
      ),
      false,
      'hostname text that merely starts like a private IPv4 address should be rejected',
    );
    assertEqual(
      httpServer.isTrustedHttpRequest(
        { socket: { remoteAddress: '192.168.50.4' }, headers: { host: 'fc00.attacker.example:8100' } },
        true,
      ),
      false,
      'hostname text that starts like an IPv6 ULA should be rejected',
    );
    assertDeepEqual(
      httpServer.buildBootstrapPayload(
        { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:8100' } },
        'fixture-privileged-token',
        'fixture-aircraft-token',
      ),
      {
        ok: true,
        wsAuthToken: 'fixture-privileged-token',
        aircraftControlToken: 'fixture-aircraft-token',
        remoteAccessEnabled: false,
        networkInfo: { ips: [], httpPort: null, wsPort: null },
      },
      'loopback bootstrap should expose both distinct session tokens',
    );
    assertDeepEqual(
      httpServer.buildBootstrapPayload(
        {
          socket: { remoteAddress: '127.0.0.1' },
          headers: { host: 'localhost:8100', origin: 'http://localhost:3000' },
        },
        'fixture-privileged-token',
        'fixture-aircraft-token',
        { ips: ['192.168.50.49'], httpPort: 8100, wsPort: 9199 },
      ),
      {
        ok: true,
        wsAuthToken: '',
        aircraftControlToken: '',
        remoteAccessEnabled: false,
        networkInfo: { ips: [], httpPort: null, wsPort: null },
      },
      'a different localhost browser origin should receive no session secrets or network details',
    );
    assertDeepEqual(
      httpServer.buildBootstrapPayload(
        { socket: { remoteAddress: '192.168.50.4' }, headers: { host: '192.168.50.49:8100' } },
        'fixture-privileged-token',
        'fixture-aircraft-token',
      ),
      {
        ok: true,
        wsAuthToken: '',
        aircraftControlToken: '',
        remoteAccessEnabled: false,
        networkInfo: { ips: [], httpPort: null, wsPort: null },
      },
      'LAN bootstrap should expose neither session token',
    );
    assertDeepEqual(
      httpServer.buildBootstrapPayload(
        { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.example:8100' } },
        'fixture-privileged-token',
        'fixture-aircraft-token',
        { ips: ['192.168.50.49'], httpPort: 8100, wsPort: 9199 },
      ),
      {
        ok: true,
        wsAuthToken: '',
        aircraftControlToken: '',
        remoteAccessEnabled: false,
        networkInfo: { ips: [], httpPort: null, wsPort: null },
      },
      'loopback peer with a non-loopback Host should expose no session secrets or network details',
    );
    const lanPolicy = httpServer.buildContentSecurityPolicy(
      { headers: { host: '192.168.50.49:8100' } },
      'fixture-nonce',
      true,
    );
    assertIncludes(lanPolicy, "script-src 'self' 'nonce-fixture-nonce'", 'CSP should permit only self-hosted and nonced scripts');
    assertNotIncludes(lanPolicy, "'unsafe-eval'", 'CSP should reject eval-style script execution');
    assertIncludes(lanPolicy, 'ws://192.168.50.49:*', 'trusted LAN CSP should allow the selected host on the WebSocket port');
    assertIncludes(lanPolicy, 'https://tiles.openfreemap.org', 'CSP should allow the configured OpenFreeMap vector basemap');
    assertIncludes(lanPolicy, 'img-src \'self\' data: blob: https://tiles.openfreemap.org', 'CSP should allow the OpenFreeMap raster fallback');
    assertNotIncludes(lanPolicy, 'basemaps.cartocdn.com', 'CSP should not add a credential-dependent CARTO fallback');
    assertNotIncludes(lanPolicy, 'tile.openstreetmap.org', 'CSP should not request the community OpenStreetMap tile service');
    const reboundPolicy = httpServer.buildContentSecurityPolicy(
      { headers: { host: 'evil.example:8100' } },
      'fixture-nonce',
      true,
    );
    assertNotIncludes(reboundPolicy, 'evil.example', 'CSP must not reflect a public or attacker-controlled Host');

    const themesDir = storagePaths.getThemesDir(process.env);
    const cabinDir = storagePaths.getCabinAnnouncementAudioDir(process.env);
    fs.mkdirSync(themesDir, { recursive: true });
    fs.mkdirSync(cabinDir, { recursive: true });

    const { httpServer: server } = httpServer.startHttpServer({
      wsPort: 9199,
      httpPort: 0,
      remoteAccessEnable: false,
      wsAuthToken: 'fixture-privileged-token',
      aircraftControlToken: 'fixture-aircraft-token',
      Debug: { log() {} },
    });

    try {
      await once(server, 'listening');
      const port = server.address().port;

      const bootstrap = await requestText(port, '/api/bootstrap');
      const bootstrapPayload = JSON.parse(bootstrap.body);
      assertEqual(bootstrapPayload.wsAuthToken, 'fixture-privileged-token', 'loopback HTTP bootstrap should return the privileged token');
      assertEqual(bootstrapPayload.aircraftControlToken, 'fixture-aircraft-token', 'loopback HTTP bootstrap should return the distinct scoped token');
      assertEqual(bootstrapPayload.remoteAccessEnabled, false, 'loopback bootstrap should report the active loopback-only binding');
      assertEqual(bootstrapPayload.networkInfo.httpPort, 0, 'loopback HTTP bootstrap should identify the configured HTTP listener port');
      assertEqual(bootstrapPayload.networkInfo.wsPort, 9199, 'loopback HTTP bootstrap should identify the configured WebSocket listener port');
      assertEqual(Array.isArray(bootstrapPayload.networkInfo.ips), true, 'loopback HTTP bootstrap should include ranked private LAN addresses');
      assertIncludes(bootstrap.headers['content-security-policy'], "default-src 'self'", 'API responses should carry the restrictive CSP');

      const dashboardPage = await requestText(port, '/');
      const dashboardPolicy = dashboardPage.headers['content-security-policy'];
      const nonceMatch = typeof dashboardPolicy === 'string'
        ? dashboardPolicy.match(/script-src 'self' 'nonce-([^']+)'/)
        : null;
      assertEqual(dashboardPage.statusCode, 200, 'dashboard should still load with CSP enabled');
      assertEqual(Boolean(nonceMatch), true, 'dashboard CSP should contain a per-response script nonce');
      assertNotIncludes(dashboardPolicy, "script-src 'self' 'unsafe-inline'", 'dashboard CSP must not allow arbitrary inline scripts');
      assertNotIncludes(dashboardPolicy, "'unsafe-eval'", 'dashboard CSP must not allow eval-style script execution');
      assertIncludes(dashboardPage.body, `<script nonce="${nonceMatch ? nonceMatch[1] : ''}">`, 'dashboard inline bootstrap should receive the matching nonce');
      const externalScriptTags = [...dashboardPage.body.matchAll(/<script\b[^>]*\bsrc\s*=[^>]*>/gi)]
        .map((match) => match[0]);
      assertEqual(externalScriptTags.length > 0, true, 'dashboard should retain its external script bootstraps');
      assertEqual(
        externalScriptTags.every((tag) => !/\bnonce\s*=/i.test(tag)),
        true,
        'dashboard external script tags should remain unchanged',
      );

      const secondDashboardPage = await requestText(port, '/');
      assertEqual(
        secondDashboardPage.headers['content-security-policy'] === dashboardPolicy,
        false,
        'dashboard CSP nonce should be fresh for each response',
      );

      const widgetPage = await requestText(port, '/widgets-compact/widget-bottom.html');
      const widgetPolicy = widgetPage.headers['content-security-policy'];
      const widgetNonceMatch = typeof widgetPolicy === 'string'
        ? widgetPolicy.match(/script-src 'self' 'nonce-([^']+)'/)
        : null;
      assertEqual(widgetPage.statusCode, 200, 'compact widget should still load with CSP enabled');
      assertIncludes(widgetPage.body, `<script nonce="${widgetNonceMatch ? widgetNonceMatch[1] : ''}">`, 'compact widget inline runtime should receive the matching nonce');

      const setupPage = await requestText(port, '/setup');
      assertIncludes(setupPage.body, '?wsPort=9199&aircraftControlToken=fixture-aircraft-token', 'local setup should carry the custom WebSocket port and scoped token in its phone URL');
      assertEqual(setupPage.body.includes('fixture-privileged-token'), false, 'local setup must never expose the privileged token in HTML');

      const foreignLoopbackOriginHeaders = {
        Host: `localhost:${port}`,
        Origin: 'http://localhost:3000',
      };
      const foreignLoopbackBootstrap = await requestText(port, '/api/bootstrap', foreignLoopbackOriginHeaders);
      const foreignLoopbackBootstrapPayload = JSON.parse(foreignLoopbackBootstrap.body);
      assertEqual(
        foreignLoopbackBootstrap.headers['access-control-allow-origin'],
        'http://localhost:3000',
        'other loopback origins may read non-secret bootstrap data',
      );
      assertEqual(foreignLoopbackBootstrapPayload.wsAuthToken, '', 'other loopback origins must not receive the privileged session token');
      assertEqual(foreignLoopbackBootstrapPayload.aircraftControlToken, '', 'other loopback origins must not receive the aircraft-control pairing token');
      assertDeepEqual(
        foreignLoopbackBootstrapPayload.networkInfo,
        { ips: [], httpPort: null, wsPort: null },
        'other loopback origins must not receive local network details',
      );
      const foreignLoopbackSetupPage = await requestText(port, '/setup', foreignLoopbackOriginHeaders);
      assertEqual(foreignLoopbackSetupPage.body.includes('fixture-aircraft-token'), false, 'other loopback origins must receive a read-only setup URL');

      const opaqueOriginHeaders = {
        Host: `localhost:${port}`,
        Origin: 'null',
      };
      const opaqueBootstrap = await requestText(port, '/api/bootstrap', opaqueOriginHeaders);
      const opaqueBootstrapPayload = JSON.parse(opaqueBootstrap.body);
      assertEqual(opaqueBootstrap.headers['access-control-allow-origin'], undefined, 'opaque Origin must not receive a readable CORS response');
      assertEqual(opaqueBootstrapPayload.wsAuthToken, '', 'opaque Origin must not receive the privileged session token');
      assertEqual(opaqueBootstrapPayload.aircraftControlToken, '', 'opaque Origin must not receive the aircraft-control pairing token');
      assertDeepEqual(opaqueBootstrapPayload.networkInfo, { ips: [], httpPort: null, wsPort: null }, 'opaque Origin must not receive local network details');
      const opaqueSetupPage = await requestText(port, '/setup', opaqueOriginHeaders);
      assertEqual(opaqueSetupPage.body.includes('fixture-aircraft-token'), false, 'opaque Origin setup page must remain read-only');

      const reboundHeaders = {
        Host: 'fc00.attacker.example:8100',
        Origin: 'http://fc00.attacker.example:8100',
      };
      const reboundBootstrap = await requestText(port, '/api/bootstrap', reboundHeaders);
      assertEqual(reboundBootstrap.statusCode, 403, 'DNS-rebound Host must be rejected before HTTP route dispatch');
      assertEqual(reboundBootstrap.headers['access-control-allow-origin'], undefined, 'DNS-rebound Host must not receive CORS permission');

      const reboundSetupPage = await requestText(port, '/setup', reboundHeaders);
      assertEqual(reboundSetupPage.statusCode, 403, 'DNS-rebound setup page must be rejected');
      const reboundFallbackPage = await requestText(port, '/not-a-real-route', reboundHeaders);
      assertEqual(reboundFallbackPage.statusCode, 403, 'DNS-rebound fallback route must be rejected');

      fs.mkdirSync(path.join(themesDir, 'theme-default.css'), { recursive: true });
      const malformedOverride = await requestText(port, '/user-assets/themes/theme-default.css');
      assertEqual(malformedOverride.statusCode, 200, 'malformed directory override should fall back to bundled theme');
      assertIncludes(malformedOverride.body, 'Theme: Default', 'bundled default theme should be returned when override path is not a file');

      fs.rmSync(path.join(themesDir, 'theme-default.css'), { recursive: true, force: true });
      const bundledTheme = await requestText(port, '/user-assets/themes/theme-default.css');
      assertEqual(bundledTheme.statusCode, 200, 'bundled theme should be served when no direct user override exists');
      assertIncludes(bundledTheme.body, 'Theme: Default', 'bundled theme should be returned without user override');

      fs.mkdirSync(themesDir, { recursive: true });
      fs.writeFileSync(path.join(themesDir, 'theme-default.css'), '/* user theme override */\n:root { --th-accent: #ff0000; }\n', 'utf8');
      const validOverride = await requestText(port, '/user-assets/themes/theme-default.css');
      assertEqual(validOverride.statusCode, 200, 'user theme override should be served');
      assertIncludes(validOverride.body, 'user theme override', 'user theme override should win over bundled fallback');

      const missingCabin = await requestBuffer(port, '/user-assets/cabin/ff-demo/climb.wav');
      assertEqual(missingCabin.statusCode, 404, 'missing direct user cabin override should return 404');

      const userCabinStyleDir = path.join(cabinDir, 'ff-demo');
      fs.mkdirSync(userCabinStyleDir, { recursive: true });
      fs.writeFileSync(path.join(userCabinStyleDir, 'climb.wav'), Buffer.from('user-cabin-audio', 'utf8'));
      const userCabin = await requestBuffer(port, '/user-assets/cabin/ff-demo/climb.wav');
      assertEqual(userCabin.statusCode, 200, 'direct user cabin override should be served');
      assertBufferString(userCabin.body, 'user-cabin-audio', 'direct user cabin override should be served from user assets');

      const outsideAssetsDir = path.join(tmpRoot, 'outside-assets');
      const redirectedCabinStyleDir = path.join(cabinDir, 'redirected');
      fs.mkdirSync(outsideAssetsDir, { recursive: true });
      fs.writeFileSync(path.join(outsideAssetsDir, 'climb.wav'), Buffer.from('outside-cabin-audio', 'utf8'));
      try {
        fs.symlinkSync(outsideAssetsDir, redirectedCabinStyleDir, 'junction');
        const redirectedCabin = await requestBuffer(port, '/user-assets/cabin/redirected/climb.wav');
        assertEqual(redirectedCabin.statusCode, 403, 'redirected user asset parents must not escape the owned cabin root');
        assertEqual(redirectedCabin.body.includes(Buffer.from('outside-cabin-audio')), false, 'redirected user assets must not disclose outside files');
      } catch (error) {
        if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
        console.log('SKIP redirected user asset parent test: junction creation unavailable');
      }

      const themeOverridePath = path.join(themesDir, 'theme-default.css');
      const outsideThemePath = path.join(outsideAssetsDir, 'outside-theme.css');
      fs.writeFileSync(outsideThemePath, '/* outside theme must not be served */', 'utf8');
      fs.rmSync(themeOverridePath, { force: true });
      try {
        fs.symlinkSync(outsideThemePath, themeOverridePath, 'file');
        const linkedTheme = await requestText(port, '/user-assets/themes/theme-default.css');
        assertEqual(linkedTheme.statusCode, 200, 'linked user theme should fall back to the bundled release theme');
        assertNotIncludes(linkedTheme.body, 'outside theme must not be served', 'linked user theme must not disclose an outside file');
        assertIncludes(linkedTheme.body, 'Theme: Default', 'linked user theme should use the bundled release fallback');
      } catch (error) {
        if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
        console.log('SKIP linked user theme test: symbolic-link creation unavailable');
      }
    } finally {
      server.close();
      await once(server, 'close');
    }

    const { httpServer: lanServer } = httpServer.startHttpServer({
      wsPort: 9199,
      httpPort: 0,
      remoteAccessEnable: true,
      wsAuthToken: 'fixture-privileged-token',
      aircraftControlToken: 'fixture-aircraft-token',
      Debug: { log() {} },
    });

    try {
      await once(lanServer, 'listening');
      const lanPort = lanServer.address().port;
      const privateOrigin = 'http://192.168.50.49:8100';
      const privateLanResponse = await requestText(lanPort, '/api/bootstrap', {
        Host: '192.168.50.49:8100',
        Origin: privateOrigin,
      });
      const privateLanPayload = JSON.parse(privateLanResponse.body);
      assertEqual(privateLanResponse.statusCode, 200, 'private Host should reach the HTTP surface in LAN mode');
      assertEqual(privateLanResponse.headers['access-control-allow-origin'], privateOrigin, 'matching private-LAN origin should receive CORS permission');
      assertEqual(privateLanPayload.wsAuthToken, '', 'private-LAN bootstrap must not receive the privileged token');
      assertEqual(privateLanPayload.aircraftControlToken, '', 'private-LAN bootstrap must not receive the aircraft-control token');
      assertEqual(privateLanPayload.remoteAccessEnabled, true, 'private-LAN bootstrap should report the active trusted-LAN binding');

      const reboundLanResponse = await requestText(lanPort, '/api/bootstrap', {
        Host: 'fc00.attacker.example:8100',
        Origin: 'http://fc00.attacker.example:8100',
      });
      assertEqual(reboundLanResponse.statusCode, 403, 'public DNS-rebinding Host should be rejected in LAN mode');
      assertEqual(reboundLanResponse.headers['access-control-allow-origin'], undefined, 'public DNS-rebinding origin should not receive CORS permission');
    } finally {
      lanServer.close();
      await once(lanServer, 'close');
    }
  });

  console.log('✅ http-server user asset tests passed');
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
