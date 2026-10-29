'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');

// Exercise the actual private serving functions without starting Electron or
// loading backend settings. Parsing declarations keeps this tied to shipped code.
function loadServerFunction(relativePath, name, fileSystem) {
  const source = ts.createSourceFile(relativePath, fs.readFileSync(path.join(ROOT, relativePath), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} must exist`);
  const script = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(`${script}\n${name}`, {
    fs: fileSystem,
    Buffer,
    STATIC_ASSET_HEADERS: { 'Cache-Control': 'no-store, max-age=0' },
    injectCspNonce: html => html,
    injectRendererCspNonce: html => html,
    writeStaticError: (res, status, message) => { res.writeHead(status); res.end(message); },
  });
}

const servers = [
  { label: 'backend', file: 'backend/core/http-server.ts', name: 'streamFirstExistingFile',
    serve: (fn, req, res, file, type) => fn(res, [file], type, type === 'text/html' ? 'fixture' : undefined) },
  { label: 'Electron', file: 'electron/main.js', name: 'streamStaticFile',
    serve: (fn, req, res, file, type) => fn(req, res, file, type, { htmlNonce: 'fixture' }) },
];

test('Electron serves current assets and cabin audio while retired themes remain private', async () => {
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, '.tmp', 'ff-static-routes-'));
  const frontend = path.join(dir, 'frontend');
  const cabin = path.join(dir, 'Audio', 'Cabin');
  const themes = path.join(dir, 'Themes');
  for (const folder of [frontend, cabin, themes]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(frontend, 'index.css'), '/* current app styling */');
  fs.writeFileSync(path.join(cabin, 'climb.wav'), 'user-cabin-audio');
  fs.writeFileSync(path.join(themes, 'theme-default.css'), 'private-legacy-theme');

  // Load the actual routing and file-serving owners without starting the desktop app.
  const source = ts.createSourceFile('main.js', fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set(['isPathInsideOrEqual', 'resolveSafeStaticPath', 'getFrontendAssetCandidates',
    'writeStaticError', 'buildRendererContentSecurityPolicy', 'injectRendererCspNonce', 'streamStaticFile', 'startFrontendServer']);
  const declarations = source.statements.filter(node =>
    (ts.isFunctionDeclaration(node) && names.has(node.name?.text))
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => decl.name.getText(source) === 'MIME_TYPES')));
  const context = vm.createContext({
    require, fs, path, process, Buffer, crypto: require('node:crypto'),
    console, debugLog() {}, frontendServer: null, frontendServerStatus: 'stopped', frontendPort: 0,
    FRONTEND_HOST: '127.0.0.1', FRONTEND_DIR: frontend, FRONTEND_DIST_DIR: frontend, FRONTEND_SOURCE_DIR: frontend,
    CABIN_ANNOUNCEMENTS_DIR: cabin, THEMES_DIR: themes,
  });
  vm.runInContext(declarations.map(node => node.getText(source)).join('\n'), context);
  function request(url, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: context.frontendServer.address().port, path: url, method }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  try {
    const started = await context.startFrontendServer();
    assert.equal(started.status, 'running');
    const css = await request('/frontend/index.css');
    assert.equal(css.status, 200);
    assert.equal(css.body, '/* current app styling */');
    assert.match(css.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(css.headers['x-content-type-options'], 'nosniff');
    const head = await request('/frontend/index.css', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal((await request('/frontend/index.css', 'POST')).status, 405);
    assert.equal((await request('/user-assets/cabin/climb.wav')).body, 'user-cabin-audio');
    assert.equal((await request('/user-assets/cabin/../../Themes/theme-default.css')).status, 403);
    for (const prefix of ['/themes/', '/frontend/themes/', '/user-assets/themes/']) {
      for (const name of ['theme-default.css', 'theme-web3-dark.css']) {
        const response = await request(prefix + name);
        assert.equal(response.status, 404);
        assert.ok(!response.body.includes('private-legacy-theme'));
      }
    }
    assert.equal(fs.readFileSync(path.join(themes, 'theme-default.css'), 'utf8'), 'private-legacy-theme');
  } finally {
    if (context.frontendServer) await new Promise(resolve => context.frontendServer.close(resolve));
    assert.equal(path.dirname(dir), path.join(ROOT, '.tmp'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const implementation of servers) {
  for (const mode of ['complete', 'transfer-abort', 'open-abort', 'stat-abort', 'html-abort']) {
    test(`${implementation.label} static files release handles after ${mode}`, { timeout: 5000 }, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-http-file-lifecycle-'));
      const fixture = path.join(dir, 'payload.bin');
      const payload = Buffer.alloc(mode === 'transfer-abort' ? 8 * 1024 * 1024 : 1024, 42);
      fs.writeFileSync(fixture, payload);
      const streams = [], descriptors = new Set();
      let response;
      let writesAfterAbort = 0;
      const fileSystem = {
        ...fs,
        open(file, flags, callback) {
          fs.open(file, flags, (error, descriptor) => {
            if (!error) descriptors.add(descriptor);
            if (mode === 'open-abort') response.destroy();
            callback(error, descriptor);
          });
        },
        fstat(descriptor, callback) {
          fs.fstat(descriptor, (error, stat) => {
            if (mode === 'stat-abort') response.destroy();
            callback(error, stat);
          });
        },
        readFile(descriptor, encoding, callback) {
          fs.readFile(descriptor, encoding, (error, contents) => {
            if (mode === 'html-abort') response.destroy();
            callback(error, contents);
          });
        },
        close(descriptor, callback) {
          fs.close(descriptor, error => { descriptors.delete(descriptor); callback(error); });
        },
        createReadStream(file, options) {
          const stream = fs.createReadStream(file, options);
          streams.push(stream);
          stream.once('close', () => descriptors.delete(options.fd));
          return stream;
        },
      };
      const serve = loadServerFunction(implementation.file, implementation.name, fileSystem);
      const server = http.createServer((req, res) => {
        response = res;
        const writeHead = res.writeHead;
        res.writeHead = function (...args) {
          if (res.destroyed) writesAfterAbort++;
          return writeHead.apply(this, args);
        };
        implementation.serve(serve, req, res, fixture, mode === 'html-abort' ? 'text/html' : 'application/octet-stream');
      });
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const bytes = await new Promise((resolve, reject) => {
          let received = 0;
          const request = http.get({ host: '127.0.0.1', port: server.address().port }, res => {
            res.on('data', chunk => {
              received += chunk.length;
              if (mode === 'transfer-abort') res.destroy();
            });
            res.on('error', error => { if (mode === 'complete') reject(error); });
            res.once('close', () => resolve(received));
          });
          request.on('error', error => {
            if (mode.endsWith('-abort') && error.code === 'ECONNRESET') resolve(received);
            else reject(error);
          });
        });
        const deadline = Date.now() + 1000;
        while (descriptors.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(descriptors.size, 0, 'the disconnected response must not retain open files');
        assert.ok(streams.every(stream => stream.closed && stream.destroyed), 'body streams must close');
        assert.equal(writesAfterAbort, 0, 'late filesystem callbacks must not write headers to a closed response');
        if (mode === 'complete') assert.equal(bytes, payload.length);
      } finally {
        for (const stream of streams) stream.destroy();
        await new Promise(resolve => server.close(resolve));
        for (const stream of streams) if (!stream.closed) await once(stream, 'close');
        for (const descriptor of descriptors) { try { fs.closeSync(descriptor); } catch {} }
        fs.unlinkSync(fixture);
        fs.rmdirSync(dir);
      }
    });
  }
}
