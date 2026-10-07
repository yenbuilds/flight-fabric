'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('../shared/voice-intent');
const { createVoiceCloudCredentials } = require('./voice-cloud-credentials');
const { createVoiceCloudEngine, pcm24k } = require('./voice-cloud-engine');
const { toolsForContext, decodeProposal, interpretAudio, MODEL } = require('./voice-cloud-openai');
const gemini = require('./voice-cloud-gemini');
const { resolveSelection, listProviders, getProvider } = require('./voice-cloud-provider');
const { createVoiceRuntime } = require('./voice-runtime');

// Construct a clearly synthetic format-valid fixture without embedding a key-shaped literal.
const syntheticOpenAiKey = 'sk-' + 'synthetic_test_value_1234567890';

const catalogue = {
  configurationId: 'fenix-a320', profileKey: 'fenix/a320', profileRevision: 7,
  commands: [
    { id: 'surfaces.gear.set', label: 'Landing gear', input: { kind: 'enum', values: ['up', 'down'] }, recipe: { forbidden: true } },
    { id: 'surfaces.flaps.set', label: 'Flap detent', input: { kind: 'enum', values: ['up', '1', '2', '3', 'full'] } },
    { id: 'flightGuidance.heading.set', label: 'Selected heading', input: { kind: 'number', min: 0, max: 359, step: 1, units: 'degrees' } },
    { id: 'flightGuidance.altitude.set', label: 'Selected altitude', input: { kind: 'number', min: 0, max: 49000, step: 100, units: 'feet' } },
    { id: 'lights.beacon.set', label: 'Beacon light', input: { kind: 'boolean' } },
    { id: 'apu.start', label: 'Start APU', input: { kind: 'none' } },
  ],
};
const context = contract.createContext(catalogue, ['is the gear down']);
const gear = { decision: 'command', commandId: 'surfaces.gear.set', input: { value: 'down' } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function proposal(intent = gear) {
  const index = context.commands.findIndex(command => command.id === intent.commandId);
  return { status: 'completed', output: [{ type: 'function_call', name: `command_${index}`, arguments: JSON.stringify(intent.input) }] };
}
function assistantText(text) {
  return { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] };
}
function directoryFor(t) {
  const root = path.resolve(__dirname, '../.tmp');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'cloud-voice-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), root);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('projection takes resolved aircraft values, excludes recipes and unreviewed procedures', () => {
  assert.equal(contract.validateContext(context).profileRevision, 7);
  assert.deepEqual(context.commands.find(c => c.id === 'surfaces.flaps.set').input.values, ['up', '1', '2', '3', 'full']);
  assert.equal(JSON.stringify(context).includes('recipe'), false);
  assert.equal(context.commands.some(c => c.id === 'apu.start'), false);
  const tampered = structuredClone(context); tampered.commands[0].recipe = {};
  assert.throws(() => contract.validateContext(tampered));
  assert.throws(() => contract.validateContext({ ...context, profileRevision: -1 }));
  assert.equal(contract.sameContext(context, { ...context, profileRevision: 8 }), false);
});

test('strict intent validation rejects coercion, wrong detents, extra fields and multiple actions', () => {
  assert.deepEqual(contract.validateIntent(gear, context), gear);
  for (const invalid of [
    { ...gear, input: { value: 'DOWN' } }, { ...gear, input: { value: 'down', recipe: 'write' } },
    { ...gear, commandId: 'raw.lvar' }, { ...gear, commands: [gear] }, [gear, gear],
    { decision: 'command', commandId: 'surfaces.flaps.set', input: { value: '5' } },
    { decision: 'command', commandId: 'flightGuidance.heading.set', input: { value: '270' } },
    { decision: 'command', commandId: 'flightGuidance.heading.set', input: { value: 360 } },
    { decision: 'command', commandId: 'flightGuidance.altitude.set', input: { value: 3050 } },
    { decision: 'command', commandId: 'lights.beacon.set', input: { value: 1 } },
    { decision: 'query', query: 'invent a state answer' }, { decision: 'no-action', reason: 'free form' },
  ]) assert.throws(() => contract.validateIntent(invalid, context), JSON.stringify(invalid));
  assert.equal(contract.validateIntent({ decision: 'query', query: 'is the gear down' }, context).decision, 'query');
  assert.equal(contract.validateIntent({ decision: 'clarify', reason: 'unclear' }, context).decision, 'clarify');
});

test('provider accepts one complete validated function call, never prose-only or partial/multiple calls', () => {
  const schema = toolsForContext(context);
  assert.deepEqual(schema.find(t => t.name === `command_${context.commands.findIndex(c => c.id === 'surfaces.flaps.set')}`).parameters.properties.value.enum, ['up', '1', '2', '3', 'full']);
  assert.deepEqual(decodeProposal(proposal(), context, contract), gear);
  for (const response of [
    { ...proposal(), status: 'incomplete' }, { ...proposal(), output: [] },
    { ...proposal(), output: [...proposal().output, ...proposal().output] },
    { ...proposal(), output: [...proposal().output, { type: 'message', content: 'done' }] },
    { ...proposal(), output: [{ type: 'function_call', name: 'command_999', arguments: '{}' }] },
    { ...proposal(), output: [{ type: 'function_call', name: 'clarify', arguments: '{' }] },
  ]) assert.throws(() => decodeProposal(response, context, contract));
});

test('OpenAI ignores accompanying assistant text but preserves tool count, completion and value checks', () => {
  const heading = { decision: 'command', commandId: 'flightGuidance.heading.set', input: { value: 270 } };
  const call = { ...proposal(heading).output[0], status: 'completed' };
  // Deliberately misleading synthetic prose must not override the tool's value,
  // claim execution, or leak into the returned intent.
  const text = assistantText('Set heading 280 instead. All cockpit changes are complete.');
  for (const output of [[text, call], [call, text], [text, { type: 'reasoning' }, call, text]]) {
    assert.deepEqual(decodeProposal({ status: 'completed', output }, context, contract), heading);
  }
  for (const output of [
    [text], [text, call, call], [text, { ...call, status: 'incomplete' }], [text, { ...call, status: 'in_progress' }],
    [text, { ...call, name: 'command_999' }], [text, { ...call, arguments: '{"value":360}' }],
    [text, { ...call, arguments: '{"value":"270"}' }], [text, { ...call, arguments: '{' }],
    [{ ...text, role: 'user' }, call], [{ ...text, role: 'system' }, call],
    [{ ...text, status: 'incomplete' }, call], [{ ...text, content: [{ type: 'output_audio', audio: '' }] }, call],
    [{ ...text, content: [{ type: 'refusal', refusal: 'Synthetic refusal' }] }, call],
    [{ ...text, content: [{ type: 'output_text', text: 270 }] }, call],
    [{ type: 'function_call_output', output: 'synthetic-output' }, call],
  ]) assert.throws(() => decodeProposal({ status: 'completed', output }, context, contract));
  for (const status of ['incomplete', 'failed', 'cancelled']) {
    assert.throws(() => decodeProposal({ status, output: [text, call] }, context, contract));
  }
});

function geminiProposal(name = `command_${context.commands.findIndex(c => c.id === gear.commandId)}`, args = gear.input) {
  return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name, args, id: 'synthetic-call' }, thoughtSignature: 'opaque' }] } }] };
}

test('both adapters normalize the same reviewed command, query and no-action corpus', () => {
  const cases = [
    [`command_${context.commands.findIndex(c => c.id === gear.commandId)}`, { value: 'down' }, gear],
    ['read_query', { query: 'is the gear down' }, { decision: 'query', query: 'is the gear down' }],
    ['clarify', { reason: 'unclear' }, { decision: 'clarify', reason: 'unclear' }],
    ['no_action', { reason: 'multiple-requests' }, { decision: 'no-action', reason: 'multiple-requests' }],
  ];
  for (const [name, args, expected] of cases) {
    const openaiResult = { status: 'completed', output: [{ type: 'function_call', name, arguments: JSON.stringify(args) }] };
    assert.deepEqual(decodeProposal(openaiResult, context, contract), expected);
    assert.deepEqual(gemini.decodeProposal(geminiProposal(name, args), context, contract), expected);
  }
  // Deliberately invalid provider proposals, not acoustic-recognition evidence.
  for (const [name, args] of [['command_999', {}], ['read_query', { query: 'invent an answer' }],
    [`command_${context.commands.findIndex(c => c.id === 'surfaces.flaps.set')}`, { value: '5' }],
    [`command_${context.commands.findIndex(c => c.id === 'flightGuidance.heading.set')}`, { value: '270' }]]) {
    assert.throws(() => gemini.decodeProposal(geminiProposal(name, args), context, contract));
    assert.throws(() => decodeProposal({ status: 'completed', output: [{ type: 'function_call', name, arguments: JSON.stringify(args) }] }, context, contract));
  }
  for (const mutation of [
    result => { result.candidates[0].finishReason = 'MAX_TOKENS'; },
    result => { result.promptFeedback = { blockReason: 'SAFETY' }; },
    result => { result.candidates.push(result.candidates[0]); },
    result => { result.candidates[0].content.parts.push(result.candidates[0].content.parts[0]); },
    result => { result.candidates[0].content.parts.push({ text: 'executed' }); },
    result => { result.candidates[0].content.parts[0].functionCall.args = { value: 'down', rawRecipe: 'invalid' }; },
  ]) { const response = geminiProposal(); mutation(response); assert.throws(() => gemini.decodeProposal(response, context, contract)); }
});

test('Gemini sends one inline WAV request with a provider-scoped header and canonical tool inputs', async () => {
  const requests = [];
  const result = await gemini.interpretAudio({ audio: Buffer.alloc(4800), context, contract, apiKey: 'synthetic-google-key',
    fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ ...geminiProposal(), usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 12, thoughtsTokenCount: 8 } })); } });
  assert.deepEqual(result.intent, gear); assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 20 });
  assert.equal(requests.length, 1);
  const { url, options } = requests[0];
  assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${gemini.MODEL}:generateContent`);
  assert.equal(options.headers['x-goog-api-key'], 'synthetic-google-key');
  assert.equal(options.redirect, 'error');
  assert.equal(options.body.includes('synthetic-google-key'), false);
  const body = JSON.parse(options.body);
  const media = body.contents[0].parts[0].inlineData;
  const wav = Buffer.from(media.data, 'base64');
  assert.equal(media.mimeType, 'audio/wav'); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt32LE(40), 4800);
  assert.equal(body.contents.length, 1); assert.equal(body.store, false);
  assert.equal(body.toolConfig.functionCallingConfig.mode, 'ANY');
  assert.deepEqual(body.tools[0].functionDeclarations.map(tool => tool.parametersJsonSchema), toolsForContext(context).map(tool => tool.parameters));
  assert.equal(options.signal.aborted, true, 'provider resources are retired after completion');
});

test('Gemini authentication, quota, malformed/oversized responses, cancellation and timeouts fail closed', async () => {
  for (const [status, code] of [[400, 'CLOUD_REQUEST'], [401, 'CLOUD_AUTH'], [403, 'CLOUD_AUTH'], [429, 'CLOUD_QUOTA'], [503, 'CLOUD_CONNECTION']]) {
    await assert.rejects(gemini.interpretAudio({ audio: Buffer.alloc(4800), context, contract, apiKey: 'synthetic-secret',
      fetchImpl: async () => new Response('synthetic-secret-provider-error', { status }) }), error => error.code === code && !error.message.includes('synthetic'));
  }
  for (const payload of ['synthetic-secret-malformed-json', 'x'.repeat(524289)]) {
    await assert.rejects(gemini.interpretAudio({ audio: Buffer.alloc(4800), context, contract, apiKey: 'synthetic-secret',
      fetchImpl: async () => new Response(payload) }), error => !error.message.includes('synthetic'));
  }
  for (const failure of ['abort', 'timeout', 'stalled-body']) {
    const controller = new AbortController(); let transportSignal; let cancelledBody = false;
    const result = gemini.interpretAudio({ audio: Buffer.alloc(4800), context, contract, apiKey: 'synthetic-secret',
      signal: controller.signal, deadlineMs: 15,
      fetchImpl: async (_url, options) => { transportSignal = options.signal;
        if (failure === 'stalled-body') return new Response(new ReadableStream({ cancel() { cancelledBody = true; } }));
        return new Promise(() => {});
      } });
    const rejected = assert.rejects(result, error => error.code === (failure === 'abort' ? 'CLOUD_CANCELLED' : 'CLOUD_TIMEOUT'));
    if (failure === 'abort') controller.abort();
    await rejected;
    assert.equal(transportSignal.aborted, true);
    if (failure === 'stalled-body') assert.equal(cancelledBody, true);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(gemini.interpretAudio({ signal: controller.signal, fetchImpl: () => assert.fail('pre-cancelled request cannot connect') }));
});

test('registry allows only reviewed provider/model combinations and exposes no runtime capabilities', () => {
  assert.deepEqual(listProviders().map(p => p.id), ['openai', 'gemini']);
  assert.equal(JSON.stringify(listProviders()).includes('interpretAudio'), false);
  assert.deepEqual(resolveSelection(), { providerId: 'openai', modelId: MODEL });
  assert.equal(resolveSelection({ providerId: 'gemini' }).modelId, gemini.MODEL);
  for (const invalid of [{ providerId: '__proto__' }, { providerId: '../openai' },
    { providerId: 'openai', modelId: gemini.MODEL }, { providerId: 'gemini', endpoint: 'https://untrusted.invalid' }]) assert.throws(() => resolveSelection(invalid));
  assert.throws(() => getProvider('constructor'));
});

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url, options) { super(); this.url = url; this.options = options; this.sent = []; FakeSocket.instances.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  terminate() { this.terminated = true; }
  receive(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
function transport(options = {}) {
  const abort = new AbortController();
  const promise = interpretAudio({ audio: Buffer.alloc(4800), context, contract,
    apiKey: 'synthetic-test-key', signal: abort.signal, WebSocketClass: FakeSocket, ...options });
  return { promise, abort, socket: FakeSocket.instances.at(-1) };
}
function submit(socket) {
  socket.receive({ type: 'session.created' });
  socket.receive({ type: 'session.updated' });
}

test('direct audio transport submits one utterance after configuration with no transcripts or history', async () => {
  const { promise, socket } = transport();
  assert.ok(socket.url.endsWith(`model=${MODEL}`));
  assert.equal(socket.options.headers.Authorization, 'Bearer synthetic-test-key');
  assert.deepEqual(socket.sent, []);
  submit(socket); submit(socket);
  assert.deepEqual(socket.sent.map(e => e.type), ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create']);
  const session = socket.sent[0].session;
  assert.equal(session.audio.input.turn_detection, null);
  assert.equal(session.audio.input.format.rate, 24000);
  assert.deepEqual(session.output_modalities, ['text']);
  assert.match(session.instructions, /fenix\/a320/);
  assert.equal(JSON.stringify(socket.sent).includes('synthetic-test-key'), false);
  socket.receive({ type: 'response.function_call_arguments.delta', delta: 'invalid partial' });
  socket.receive({ type: 'response.done', response: proposal() });
  assert.deepEqual((await promise).intent, gear);
  assert.equal(socket.terminated, true);
});

test('transport cancellation, deadlines and provider errors close the socket with redacted errors', async () => {
  for (const mode of ['abort', 'deadline', 'auth', 'malformed', 'large', 'close']) {
    const h = transport({ deadlineMs: mode === 'deadline' ? 10 : 1000 });
    const rejected = assert.rejects(h.promise, error => !error.message.includes('synthetic-test-key'));
    if (mode === 'abort') h.abort.abort();
    if (mode === 'auth') h.socket.emit('unexpected-response', {}, { statusCode: 401, resume() {} });
    if (mode === 'malformed') h.socket.emit('message', Buffer.from('synthetic-test-key'));
    if (mode === 'large') h.socket.emit('message', Buffer.alloc(524289));
    if (mode === 'close') h.socket.emit('close');
    await rejected;
    assert.equal(h.socket.terminated, true);
  }
});

test('both providers reject cumulative oversized responses and retire the transport before a late proposal', async t => {
  for (const providerId of ['openai', 'gemini']) await t.test(providerId, async () => {
    let result, sendChunk, sendProposal, assertClosed;
    // Deliberately oversized provider input tests resource bounds, not speech accuracy.
    // Each piece is small enough on its own; only their accumulated size exceeds 512 KiB.
    if (providerId === 'openai') {
      const h = transport();
      submit(h.socket);
      const chunk = Buffer.from(JSON.stringify({ type: 'response.function_call_arguments.delta', delta: ' '.repeat(128 * 1024) }));
      assert.ok(chunk.length < h.socket.options.maxPayload);
      result = h.promise;
      sendChunk = () => h.socket.emit('message', chunk);
      sendProposal = () => h.socket.receive({ type: 'response.done', response: proposal() });
      assertClosed = () => assert.equal(h.socket.terminated, true);
    } else {
      let body, transportSignal, cancelledBody = false;
      const response = new Response(new ReadableStream({
        start(controller) { body = controller; },
        cancel() { cancelledBody = true; },
      }));
      assert.equal(response.headers.has('content-length'), false, 'streaming limits must not depend on a declared length');
      result = gemini.interpretAudio({ audio: Buffer.alloc(4800), context, contract, apiKey: 'synthetic-test-key',
        fetchImpl: async (_url, options) => { transportSignal = options.signal; return response; } });
      // JSON permits leading whitespace, so without the cumulative bound this would be a valid proposal.
      sendChunk = () => body.enqueue(Buffer.alloc(128 * 1024, ' '));
      sendProposal = () => { body.enqueue(Buffer.from(JSON.stringify(geminiProposal()))); body.close(); };
      assertClosed = () => {
        assert.equal(transportSignal.aborted, true);
        assert.equal(cancelledBody, true, 'stop reading the oversized response body');
      };
    }
    const rejected = assert.rejects(result, error => error.code === 'CLOUD_INVALID');
    for (let index = 0; index < 5; index++) sendChunk();
    sendProposal();
    await rejected;
    assertClosed();
  });
});

function engineFixture(t, interpret, options = {}) {
  const events = [], calls = [];
  const engine = createVoiceCloudEngine({ loadContract: () => contract, getApiKey: () => 'synthetic-test-key',
    interpret: async args => { calls.push(args); return interpret ? interpret(args) : { intent: gear }; }, ...options });
  engine.onEvent(event => events.push(event));
  t.after(() => engine.shutdown());
  return { engine, events, calls };
}
function audio(engine, sessionId, options = {}) {
  engine.pushAudio({ sessionId, sequence: 0, sampleRate: 48000, samples: new Float32Array(4800).fill(0.1), ...options });
}

test('cloud engine buffers PCM until release and emits only a validated final once', async t => {
  const h = engineFixture(t); await h.engine.initialize();
  const { sessionId } = h.engine.start({ context });
  audio(h.engine, sessionId);
  assert.equal(h.calls.length, 0);
  assert.equal(h.engine.finish(sessionId), true);
  assert.equal(h.engine.finish(sessionId), false);
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].audio.length, 4800);
  assert.deepEqual(h.events.map(e => [e.type, e.intent]), [['final', gear]]);
  assert.equal(h.engine.getInfo().activeSessionId, null);
  assert.equal(JSON.stringify(h.events).includes('synthetic-test-key'), false);
});

test('Realtime assistant text never reaches the voice result or substitutes for a valid proposal', async t => {
  const h = engineFixture(t, args => interpretAudio({ ...args, WebSocketClass: FakeSocket }));
  await h.engine.initialize();
  const heading = { decision: 'command', commandId: 'flightGuidance.heading.set', input: { value: 270 } };
  const text = assistantText('Synthetic untrusted claim: heading 280 is already set.');
  for (const valid of [false, true]) {
    const { sessionId } = h.engine.start({ context });
    audio(h.engine, sessionId); h.engine.finish(sessionId);
    const socket = FakeSocket.instances.at(-1);
    submit(socket);
    socket.receive({ type: 'response.output_text.delta', delta: text.content[0].text });
    assert.equal(h.events.length, valid ? 1 : 0, 'streaming prose cannot finish the session');
    socket.receive({ type: 'response.done', response: { status: 'completed', output: valid ? [text, ...proposal(heading).output] : [text] } });
    await tick();
    const event = h.events.at(-1);
    assert.equal(event.sessionId, sessionId);
    assert.equal(event.type, valid ? 'final' : 'error');
    if (valid) {
      assert.deepEqual(event.intent, heading);
      assert.equal(event.text, '');
    } else {
      assert.equal(event.code, 'CLOUD_INVALID');
      assert.match(event.message, /invalid or incomplete proposal/);
    }
    assert.equal(JSON.stringify(h.events).includes('Synthetic untrusted'), false);
    assert.equal(socket.terminated, true);
    assert.equal(h.engine.getInfo().activeSessionId, null);
  }
});

test('Realtime mixed-output replies from retired sessions cannot affect a new request', async t => {
  for (const reason of ['cancel', 'provider-revision', 'deadline']) await t.test(reason, async t => {
    let selection = { ...resolveSelection(), revision: 0 };
    const h = engineFixture(t, args => interpretAudio({ ...args, WebSocketClass: FakeSocket }), {
      getSelection: () => selection, resultTimeoutMs: reason === 'deadline' ? 15 : 1000,
    });
    await h.engine.initialize();
    const old = h.engine.start({ context });
    audio(h.engine, old.sessionId); h.engine.finish(old.sessionId);
    const oldSocket = FakeSocket.instances.at(-1);
    submit(oldSocket);
    const heading = { decision: 'command', commandId: 'flightGuidance.heading.set', input: { value: 270 } };
    const response = { status: 'completed', output: [assistantText('Synthetic assistant text.'), ...proposal(heading).output] };
    const terminal = new Promise(resolve => {
      const stop = h.engine.onEvent(event => { stop(); resolve(event); });
    });
    if (reason === 'cancel') h.engine.cancel(old.sessionId);
    if (reason === 'provider-revision') {
      selection = { ...selection, revision: 1 };
      oldSocket.receive({ type: 'response.done', response });
    }
    const event = await terminal;
    assert.equal(event.sessionId, old.sessionId);
    assert.equal(event.type, reason === 'deadline' ? 'error' : 'cancelled');
    if (reason === 'deadline') assert.equal(event.code, 'CLOUD_TIMEOUT');
    assert.equal(oldSocket.terminated, true);
    assert.equal(h.calls[0].signal.aborted, true);

    const fresh = h.engine.start({ context });
    audio(h.engine, fresh.sessionId); h.engine.finish(fresh.sessionId);
    const freshSocket = FakeSocket.instances.at(-1);
    submit(oldSocket);
    oldSocket.receive({ type: 'response.done', response });
    oldSocket.receive({ type: 'error', error: { code: 'invalid_api_key', type: 'invalid_request_error' } });
    assert.equal(h.events.length, 1, 'late old replies cannot emit another terminal event');
    assert.equal(h.engine.getInfo().activeSessionId, fresh.sessionId);
    assert.equal(oldSocket.sent.filter(item => item.type === 'response.create').length, 1);
    submit(freshSocket);
    freshSocket.receive({ type: 'response.done', response });
    freshSocket.receive({ type: 'response.done', response });
    await tick();
    assert.deepEqual(h.events.map(item => [item.type, item.sessionId]), [[event.type, old.sessionId], ['final', fresh.sessionId]]);
    assert.deepEqual(h.events[1].intent, heading);
    assert.equal(h.events[1].text, '');
    assert.equal(freshSocket.terminated, true);
    assert.equal(h.engine.getInfo().activeSessionId, null);
  });
});

test('each engine session freezes the provider/model and only reads that provider key', async t => {
  for (const providerId of ['openai', 'gemini']) {
    let selection = { ...resolveSelection({ providerId }), revision: 3 };
    const reads = [];
    const h = engineFixture(t, undefined, { getSelection: () => selection, getApiKey: id => { reads.push(id); return 'synthetic-test-key'; } });
    await h.engine.initialize(); const started = h.engine.start({ context });
    audio(h.engine, started.sessionId); h.engine.finish(started.sessionId); await tick();
    assert.deepEqual(reads, [providerId, providerId]);
    assert.equal(h.calls[0].modelId, selection.modelId);
    assert.deepEqual(h.events[0].selection, selection);
    assert.throws(() => { started.selection.providerId = 'another'; });
    const next = h.engine.start({ context }); audio(h.engine, next.sessionId);
    selection = { ...selection, revision: 4 };
    assert.equal(h.engine.finish(next.sessionId), false);
    assert.equal(h.calls.length, 1, 'changed settings cannot upload old audio');
  }
});

test('an in-flight result is discarded if the provider configuration revision changed', async t => {
  let selection = { ...resolveSelection({ providerId: 'gemini' }), revision: 0 }, complete;
  const h = engineFixture(t, () => new Promise(resolve => { complete = resolve; }), { getSelection: () => selection });
  await h.engine.initialize(); const { sessionId } = h.engine.start({ context }); audio(h.engine, sessionId); h.engine.finish(sessionId);
  selection = { ...selection, revision: 1 };
  complete({ intent: gear }); await tick();
  assert.equal(h.events.some(event => event.type === 'final'), false);
  assert.equal(h.engine.getInfo().activeSessionId, null);
});

test('cancel, shutdown and result deadline discard late cloud responses', async t => {
  for (const mode of ['cancel', 'shutdown', 'timeout']) {
    let resolve;
    const h = engineFixture(t, () => new Promise(r => { resolve = r; }), { resultTimeoutMs: 15 });
    await h.engine.initialize(); const { sessionId } = h.engine.start({ context }); audio(h.engine, sessionId);
    h.engine.finish(sessionId);
    if (mode === 'cancel') h.engine.cancel(sessionId);
    if (mode === 'shutdown') await h.engine.shutdown();
    if (mode === 'timeout') await new Promise(r => setTimeout(r, 25));
    assert.equal(h.calls[0].signal.aborted, true);
    resolve({ intent: gear }); await tick();
    assert.equal(h.events.some(e => e.type === 'final'), false);
    assert.equal(h.engine.getInfo().activeSessionId, null);
  }
});

test('provider failures expose fixed actionable feedback without forwarding error payloads', async t => {
  for (const code of ['CLOUD_AUTH', 'CLOUD_REQUEST', 'CLOUD_QUOTA', 'CLOUD_CONNECTION', 'CLOUD_TIMEOUT', 'untrusted-code']) {
    const h = engineFixture(t, () => { throw Object.assign(new Error('synthetic-secret-provider-payload'), { code }); });
    await h.engine.initialize(); const { sessionId } = h.engine.start({ context });
    audio(h.engine, sessionId); h.engine.finish(sessionId); await tick();
    assert.equal(h.events[0].type, 'error');
    assert.equal(h.events[0].code, code === 'untrusted-code' ? 'CLOUD_FAILED' : code);
    assert.equal(JSON.stringify(h.events).includes('synthetic-secret-provider-payload'), false);
    assert.equal(h.engine.getInfo().activeSessionId, null);
  }
});

test('Realtime error events report authentication and request failures, retire the session and allow retry', async t => {
  // Authentication shape observed in a live connection-only diagnostic. Other
  // cases exercise documented error envelopes, not live speech recognition.
  const cases = [
    ['invalid_api_key', 'invalid_request_error', 'CLOUD_AUTH', false],
    ['unknown_parameter', 'invalid_request_error', 'CLOUD_REQUEST', true],
    ['model_not_found', 'invalid_request_error', 'CLOUD_REQUEST', false],
    ['insufficient_quota', 'invalid_request_error', 'CLOUD_QUOTA', false],
    ['rate_limit_exceeded', 'invalid_request_error', 'CLOUD_QUOTA', true],
    [null, 'server_error', 'CLOUD_CONNECTION', true],
  ];
  for (const [code, type, expected, configuring] of cases) await t.test(code || type, async t => {
    const h = engineFixture(t, args => interpretAudio({ ...args, WebSocketClass: FakeSocket }));
    await h.engine.initialize();
    const failed = h.engine.start({ context });
    audio(h.engine, failed.sessionId); h.engine.finish(failed.sessionId);
    const socket = FakeSocket.instances.at(-1);
    if (configuring) socket.receive({ type: 'session.created' });
    socket.receive({ type: 'error', error: { code, type, message: 'synthetic-sensitive-provider-payload', param: 'synthetic-private-parameter' } });
    await tick();
    assert.equal(socket.terminated, true);
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.engine.getInfo().activeSessionId, null);
    assert.deepEqual(h.events.map(e => [e.type, e.sessionId, e.code]), [['error', failed.sessionId, expected]]);
    if (expected === 'CLOUD_AUTH') assert.match(h.events[0].message, /OpenAI rejected the API key/);
    if (expected === 'CLOUD_REQUEST') assert.match(h.events[0].message, /OpenAI rejected the voice request/);
    assert.equal(JSON.stringify(h.events).includes('synthetic-'), false);
    assert.deepEqual(socket.sent.map(e => e.type), configuring ? ['session.update'] : []);

    const retry = h.engine.start({ context });
    audio(h.engine, retry.sessionId); h.engine.finish(retry.sessionId);
    const freshSocket = FakeSocket.instances.at(-1);
    submit(socket);
    socket.receive({ type: 'response.done', response: proposal() });
    assert.deepEqual(socket.sent.map(e => e.type), configuring ? ['session.update'] : [], 'late events cannot upload retired audio');
    assert.equal(h.engine.getInfo().activeSessionId, retry.sessionId);
    submit(freshSocket);
    freshSocket.receive({ type: 'response.done', response: proposal() });
    await tick();
    assert.deepEqual(h.events.map(e => [e.type, e.sessionId]), [['error', failed.sessionId], ['final', retry.sessionId]]);
    assert.deepEqual(h.events[1].intent, gear);
    assert.equal(freshSocket.terminated, true);
    assert.equal(h.engine.getInfo().activeSessionId, null);
  });
});

test('silence stays local; invalid audio robustness checks and session bounds reject malformed chunks', async t => {
  const h = engineFixture(t); await h.engine.initialize();
  let { sessionId } = h.engine.start({ context });
  audio(h.engine, sessionId, { samples: new Float32Array(4800) }); h.engine.finish(sessionId); await tick();
  assert.equal(h.calls.length, 0); assert.equal(h.events[0].intent.decision, 'no-action');
  sessionId = h.engine.start({ context }).sessionId;
  // Deliberately malformed samples test the IPC boundary, not microphone behavior.
  for (const invalid of [{ sequence: 2 }, { samples: new Float32Array([NaN]) },
    { samples: new Float32Array([1.5]) }, { samples: new Float32Array(8193) }, { sampleRate: 0 }]) {
    assert.throws(() => audio(h.engine, sessionId, invalid));
  }
  audio(h.engine, sessionId);
  assert.throws(() => audio(h.engine, sessionId), /Invalid/);
  assert.throws(() => audio(h.engine, sessionId, { sequence: 1, sampleRate: 44100 }));
  for (let sequence = 1; sequence < 100; sequence++) audio(h.engine, sessionId, { sequence });
  assert.throws(() => audio(h.engine, sessionId, { sequence: 100 }), /ten seconds/);
});

test('resampling preserves duration and full-scale PCM bounds at common microphone rates', () => {
  for (const rate of [16000, 44100, 48000]) {
    const samples = new Float32Array(rate).fill(1);
    const pcm = pcm24k([samples], samples.length, rate);
    assert.equal(pcm.length, 48000); assert.equal(pcm.readInt16LE(0), 32767);
    samples.fill(-1); assert.equal(pcm24k([samples], samples.length, rate).readInt16LE(100), -32768);
  }
});

test('credentials are protected, replaceable and removable without exposing them in status', t => {
  const directory = directoryFor(t);
  // Reversible fake encryption for unit tests only; production uses Electron safeStorage.
  const store = createVoiceCloudCredentials({ directory, getProtection: () => ({
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from([...text].reverse().join('')),
    decryptString: buffer => [...buffer.toString()].reverse().join(''),
  }) });
  const key = syntheticOpenAiKey;
  assert.equal(store.info().keyConfigured, false);
  store.save('openai', key); assert.equal(store.read(), key);
  assert.equal(JSON.stringify(store.info()).includes(key), false);
  assert.equal(fs.readFileSync(path.join(directory, 'voice-cloud-key.bin'), 'utf8').includes(key), false);
  store.save('openai', `${key}2`); assert.equal(store.read(), `${key}2`);
  assert.deepEqual(fs.readdirSync(directory), ['voice-cloud-key.bin']);
  const googleKey = 'synthetic_google_key_1234567890';
  store.save('gemini', googleKey);
  assert.equal(store.read('gemini'), googleKey);
  assert.equal(store.read('openai'), `${key}2`, 'saving Gemini preserves the legacy OpenAI slot');
  assert.equal(store.info('gemini').keyConfigured, true);
  assert.equal(fs.readFileSync(path.join(directory, 'voice-cloud-key-gemini.bin'), 'utf8').includes(googleKey), false);
  assert.equal(store.remove().keyConfigured, false);
  assert.equal(store.read('gemini'), googleKey, 'removing OpenAI cannot remove Gemini');
  assert.throws(() => store.read('../openai'));
  assert.throws(() => store.read(), /could not be read/);
  assert.throws(() => store.save('openai', 'invalid-secret'), error => !error.message.includes('invalid-secret'));
  const unsafe = createVoiceCloudCredentials({ directory, getProtection: () => ({
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text',
  }) });
  assert.equal(unsafe.info().storageAvailable, false);
  assert.throws(() => unsafe.save('openai', key));
});

test('release gate keeps saved cloud users offline and blocks cloud IPC without touching keys', async t => {
  for (const isPackaged of [false, true]) {
    for (const selection of [resolveSelection(), resolveSelection({ providerId: 'gemini' }), { providerId: 'retired-provider' }]) {
      const directory = directoryFor(t), handlers = new Map(), audio = [];
      const settingsFile = path.join(directory, 'voice-control.json');
      const settings = { voiceRecognitionEnabled: true, voiceMode: 'cloud', voiceCloud: selection };
      fs.writeFileSync(settingsFile, JSON.stringify(settings));
      const keyFiles = ['voice-cloud-key.bin', 'voice-cloud-key-gemini.bin'];
      const savedBytes = Buffer.from('synthetic-protected-storage-fixture');
      for (const file of keyFiles) fs.writeFileSync(path.join(directory, file), savedBytes);
      let ready = false, activeSessionId = null, cloudCalls = 0;
      const forbidden = () => { cloudCalls++; throw new Error('Disabled cloud dependency was accessed'); };
      const runtime = createVoiceRuntime({ app: { isPackaged, getPath: () => directory }, appDir: directory,
        ipcMain: new EventEmitter(), getMainWindow: () => null,
        speechEngine: {
          initialize: async () => { ready = true; }, shutdown: async () => { ready = false; activeSessionId = null; },
          getInfo: () => ({ ready, activeSessionId }), onEvent() {},
          start: options => { assert.equal(options, undefined); return { sessionId: activeSessionId = 'offline-session' }; },
          pushAudio: chunk => audio.push(chunk),
          finish: id => { assert.equal(id, activeSessionId); activeSessionId = null; return true; },
          cancel: () => { activeSessionId = null; return true; },
        },
        cloudEngine: { initialize: forbidden, getInfo: forbidden, onEvent: forbidden, start: forbidden, shutdown: forbidden },
        credentialStore: { info: forbidden, read: forbidden, save: forbidden, remove: forbidden },
        readbackEngine: { getInfo: () => ({}), cancel() {} },
        registerTrustedIpcHandler: (name, handler) => handlers.set(name, handler),
        pushToTalkHookFactory: () => ({ setBinding: async () => {}, getInfo: () => ({}), dispose() {} }),
      });
      t.after(() => runtime.shutdown());
      const owner = { id: 1 };
      const invoke = (name, value) => handlers.get(`voice:${name}`)({ sender: owner }, value);
      await runtime.initialize();
      assert.equal(runtime.runtimeInfo().available, true);
      assert.equal(runtime.runtimeInfo().mode, 'offline');
      assert.deepEqual(runtime.runtimeInfo().cloud, { enabled: false });
      const { sessionId } = invoke('speech-start', { context });
      for (const [name, value] of [
        ['set-mode', 'cloud'], ['set-cloud-provider', { providerId: 'openai' }],
        ['save-cloud-key', { providerId: 'openai', key: syntheticOpenAiKey }], ['remove-cloud-key', 'openai'],
      ]) assert.throws(() => invoke(name, value), /disabled in this release/);
      assert.equal(runtime.isAudioCaptureAuthorized(owner), true, 'blocked settings cannot disrupt offline capture');
      invoke('speech-audio', { sessionId, sequence: 0, sampleRate: 48000, samples: new Float32Array(2048).buffer });
      assert.equal(audio.length, 1);
      assert.deepEqual(invoke('speech-finish', sessionId), { finishing: true });
      assert.equal(runtime.isAudioCaptureAuthorized(owner), false);
      await invoke('set-recognition-enabled', false);
      assert.equal(runtime.runtimeInfo().available, false);
      await invoke('set-recognition-enabled', true);
      assert.equal(runtime.runtimeInfo().available, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).voiceCloud, selection);
      assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).voiceMode, 'cloud', 'release gate preserves the dormant preference');
      await runtime.shutdown();
      for (const file of keyFiles) assert.deepEqual(fs.readFileSync(path.join(directory, file)), savedBytes);
      assert.equal(cloudCalls, 0, 'no cloud engine or credential access, including during shutdown');
    }
  }
});

test('desktop mode routing bypasses Zipformer, cancels on settings changes, and leaves keys out of JSON', async t => {
  const directory = directoryFor(t), handlers = new Map(), sent = [], starts = [];
  fs.writeFileSync(path.join(directory, 'voice-control.json'), JSON.stringify({ voiceRecognitionEnabled: true }));
  function engine(name) {
    let ready = false, activeSessionId = null;
    return { initialize: async () => { ready = true; }, shutdown: async () => { ready = false; activeSessionId = null; },
      getInfo: () => ({ ready, activeSessionId }), onEvent() {},
      start: options => { starts.push({ name, options }); return { sessionId: activeSessionId = `${name}-session` }; },
      cancel: () => { activeSessionId = null; return true; } };
  }
  const configured = new Set();
  const runtime = createVoiceRuntime({ app: { isPackaged: false, getPath: () => directory }, appDir: directory,
    cloudVoiceEnabled: true, // Explicitly exercise the retained preview behind the release gate.
    ipcMain: new EventEmitter(), speechEngine: engine('offline'), cloudEngine: engine('cloud'),
    credentialStore: { info: id => ({ keyConfigured: configured.has(id), storageAvailable: true }), save: id => { configured.add(id); }, remove: id => { configured.delete(id); } },
    readbackEngine: { getInfo: () => ({}), cancel() {} },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, data) => sent.push({ channel, data }) } }),
    registerTrustedIpcHandler: (name, handler) => handlers.set(name, handler),
    pushToTalkHookFactory: () => ({ setBinding: async () => {}, getInfo: () => ({}), dispose() {} }),
  });
  t.after(() => runtime.shutdown()); await runtime.initialize();
  const invoke = (name, value) => handlers.get(`voice:${name}`)({ sender: { id: 1 } }, value);
  assert.equal(runtime.runtimeInfo().mode, 'offline');
  invoke('speech-start');
  await invoke('save-cloud-key', { providerId: 'openai', key: syntheticOpenAiKey });
  await invoke('set-mode', 'cloud');
  invoke('speech-start', { context });
  assert.deepEqual(starts.map(s => s.name), ['offline', 'cloud']);
  assert.deepEqual(starts[1].options, { context });
  assert.equal(runtime.isAudioCaptureAuthorized({ id: 1 }), true);
  await invoke('remove-cloud-key', 'openai');
  assert.equal(runtime.isAudioCaptureAuthorized({ id: 1 }), false);
  const persisted = fs.readFileSync(path.join(directory, 'voice-control.json'), 'utf8');
  assert.equal(JSON.parse(persisted).voiceMode, 'cloud');
  assert.equal(persisted.includes('synthetic'), false);
  assert.equal(JSON.stringify(sent).includes('synthetic'), false);
  await invoke('save-cloud-key', { providerId: 'openai', key: syntheticOpenAiKey });
  await invoke('save-cloud-key', { providerId: 'gemini', key: 'synthetic_google_key_1234567890' });
  const previousRevision = runtime.runtimeInfo().cloud.revision;
  invoke('speech-start', { context });
  await invoke('set-cloud-provider', { providerId: 'gemini' });
  assert.equal(runtime.isAudioCaptureAuthorized({ id: 1 }), false);
  assert.equal(runtime.runtimeInfo().cloud.providerId, 'gemini');
  assert.ok(runtime.runtimeInfo().cloud.revision > previousRevision);
  assert.equal(runtime.runtimeInfo().cloud.providers.every(provider => provider.keyConfigured), true);
  await invoke('remove-cloud-key', 'gemini');
  assert.equal(runtime.runtimeInfo().cloud.keyConfigured, false);
  assert.equal(runtime.runtimeInfo().cloud.providers.find(p => p.id === 'openai').keyConfigured, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'voice-control.json'), 'utf8')).voiceCloud, resolveSelection({ providerId: 'gemini' }));
  assert.throws(() => invoke('set-cloud-provider', { providerId: 'gemini', modelId: MODEL }));
  const blockedSave = path.join(directory, 'voice-control.json.tmp'); fs.mkdirSync(blockedSave);
  await assert.rejects(invoke('set-cloud-provider', { providerId: 'openai' }));
  assert.equal(runtime.runtimeInfo().cloud.providerId, 'gemini', 'a failed preference write retains the selected provider');
  fs.rmdirSync(blockedSave);
  await invoke('set-mode', 'offline');
  assert.equal(runtime.runtimeInfo().available, true);
  assert.throws(() => invoke('set-mode', 'untrusted-provider'));
});

test('restart preserves provider selection, migrates legacy OpenAI settings, and blocks unsupported saved configurations', async t => {
  for (const scenario of ['legacy', 'gemini', 'invalid', 'offline-invalid']) {
    const directory = directoryFor(t), handlers = new Map(), reads = [];
    const invalid = scenario.includes('invalid');
    const settings = { voiceRecognitionEnabled: true, voiceMode: scenario === 'offline-invalid' ? 'offline' : 'cloud',
      ...(scenario === 'legacy' ? {} : { voiceCloud: invalid ? { providerId: 'unconfigured-provider' } : resolveSelection({ providerId: 'gemini' }) }) };
    fs.writeFileSync(path.join(directory, 'voice-control.json'), JSON.stringify(settings));
    let offlineReady = false;
    const runtime = createVoiceRuntime({ app: { isPackaged: false, getPath: () => directory }, appDir: directory,
      cloudVoiceEnabled: true,
      ipcMain: new EventEmitter(), getMainWindow: () => null,
      speechEngine: { initialize: async () => { offlineReady = true; }, shutdown: async () => { offlineReady = false; },
        getInfo: () => ({ ready: offlineReady }), onEvent() {} },
      credentialStore: { info: () => ({ keyConfigured: true, storageAvailable: true }), read: id => { reads.push(id); return 'synthetic-key'; } },
      readbackEngine: { getInfo: () => ({}), cancel() {} },
      registerTrustedIpcHandler: (name, handler) => handlers.set(name, handler),
      pushToTalkHookFactory: () => ({ setBinding: async () => {}, getInfo: () => ({}), dispose() {} }),
    });
    t.after(() => runtime.shutdown());
    await runtime.initialize();
    assert.equal(runtime.runtimeInfo().available, scenario !== 'invalid');
    assert.deepEqual(reads, invalid ? [] : [scenario === 'legacy' ? 'openai' : 'gemini']);
    assert.equal(runtime.runtimeInfo().cloud.selectionValid, !invalid);
    if (scenario === 'invalid') {
      assert.throws(() => handlers.get('voice:speech-start')({ sender: { id: 1 } }), /unsupported/);
      await handlers.get('voice:set-recognition-enabled')({}, false);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'voice-control.json'), 'utf8')).voiceCloud, settings.voiceCloud,
        'unrelated settings must not silently migrate an unsupported provider to OpenAI on the next restart');
      await handlers.get('voice:set-recognition-enabled')({}, true);
      assert.deepEqual(reads, []);
      await handlers.get('voice:set-cloud-provider')({}, { providerId: 'gemini' });
      assert.equal(runtime.runtimeInfo().available, true);
      assert.equal(runtime.runtimeInfo().cloud.selectionValid, true);
      assert.deepEqual(reads, ['gemini']);
    }
  }
});
