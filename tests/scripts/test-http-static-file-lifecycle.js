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
