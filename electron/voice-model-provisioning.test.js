'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { provisionVoiceModel } = require('./scripts/provision-voice-model');

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
}

function fixtureModel(contents) {
  const revision = '0123456789abcdef0123456789abcdef01234567';
  return {
    id: 'test-zipformer',
    obsoleteFiles: ['hotwords.txt'],
    upstream: {
      revision,
      resolveUrl: `https://models.example.test/voice/resolve/${revision}/`,
    },
    files: [
      { name: 'encoder.onnx', bytes: contents.encoder.length, sha256: sha256(contents.encoder), source: 'upstream' },
      { name: 'tokens.txt', bytes: contents.tokens.length, sha256: sha256(contents.tokens), source: 'upstream' },
      { name: 'bpe.vocab', bytes: contents.bpe.length, sha256: sha256(contents.bpe), source: 'bundled' },
    ],
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-fabric-voice-model-'));
  const contents = {
    encoder: Buffer.from('verified encoder'),
    tokens: Buffer.from('verified tokens'),
    bpe: Buffer.from('verified bpe vocabulary'),
  };
  const bundledBpeVocab = path.join(root, 'bundled-bpe.vocab');
  fs.writeFileSync(bundledBpeVocab, contents.bpe);
  return {
    bundledBpeVocab,
    contents,
    destination: path.join(root, 'model'),
    model: fixtureModel(contents),
    root,
  };
}

test('offline provisioning needs only the upstream files plus the tracked BPE vocabulary', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const source = path.join(fixture.root, 'upstream');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'encoder.onnx'), fixture.contents.encoder);
  fs.writeFileSync(path.join(source, 'tokens.txt'), fixture.contents.tokens);
  fs.mkdirSync(fixture.destination);
  fs.writeFileSync(path.join(fixture.destination, 'hotwords.txt'), 'obsolete private build input');

  const result = await provisionVoiceModel({
    bundledBpeVocab: fixture.bundledBpeVocab,
    configuredSource: source,
    destination: fixture.destination,
    fetchImpl: async () => { throw new Error('network should not be used'); },
    log: () => {},
    model: fixture.model,
  });

  assert.equal(result.downloaded, false);
  assert.deepEqual(fs.readFileSync(path.join(fixture.destination, 'encoder.onnx')), fixture.contents.encoder);
  assert.deepEqual(fs.readFileSync(path.join(fixture.destination, 'tokens.txt')), fixture.contents.tokens);
  assert.deepEqual(fs.readFileSync(path.join(fixture.destination, 'bpe.vocab')), fixture.contents.bpe);
  assert.equal(fs.existsSync(path.join(fixture.destination, 'hotwords.txt')), false);
});

test('clean provisioning downloads immutable upstream files and then reuses the verified cache', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const downloads = [];
  const fetchImpl = async (url) => {
    downloads.push(url);
    const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    const content = name === 'encoder.onnx' ? fixture.contents.encoder : fixture.contents.tokens;
    return new Response(content, { status: 200 });
  };

  const first = await provisionVoiceModel({
    bundledBpeVocab: fixture.bundledBpeVocab,
    configuredSource: '',
    destination: fixture.destination,
    fetchImpl,
    log: () => {},
    model: fixture.model,
  });
  assert.equal(first.downloaded, true);
  assert.equal(downloads.length, 2);
  assert(downloads.every((url) => url.includes(fixture.model.upstream.revision)));

  const second = await provisionVoiceModel({
    bundledBpeVocab: fixture.bundledBpeVocab,
    configuredSource: '',
    destination: fixture.destination,
    fetchImpl: async () => { throw new Error('verified cache should avoid the network'); },
    log: () => {},
    model: fixture.model,
  });
  assert.equal(second.downloaded, false);
});

test('a failed download cannot install an unverified model', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    provisionVoiceModel({
      bundledBpeVocab: fixture.bundledBpeVocab,
      configuredSource: '',
      destination: fixture.destination,
      fetchImpl: async () => new Response('wrong', { status: 200 }),
      log: () => {},
      model: fixture.model,
    }),
    /wrong size|pinned size/,
  );
  assert.equal(fs.existsSync(path.join(fixture.destination, 'encoder.onnx')), false);
  assert.equal(fs.existsSync(path.join(fixture.destination, 'tokens.txt')), false);
  assert.deepEqual(
    fs.readdirSync(fixture.root).filter((name) => name.startsWith(`.${fixture.model.id}-`)),
    [],
    'failed provisioning must remove its staging directory through the safe cleanup boundary',
  );
});
