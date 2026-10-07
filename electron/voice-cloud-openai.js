'use strict';

const { DEADLINE_MS, proposalTools, decodeCall, instructionsForContext, cloudError, providerError } = require('./voice-cloud-contract');
const MODEL = 'gpt-realtime-2.1-mini';
const toolsForContext = context => proposalTools(context).map(tool => ({ type: 'function', ...tool }));

function isAssistantText(item) {
  return item?.type === 'message' && item.role === 'assistant'
    && (item.status === undefined || item.status === 'completed')
    && Array.isArray(item.content)
    && item.content.every(part => part?.type === 'output_text' && typeof part.text === 'string');
}

function decodeProposal(response, context, contract) {
  if (response?.status !== 'completed' || !Array.isArray(response.output)) throw new Error('Cloud voice did not complete a command proposal.');
  const calls = response.output.filter(item => item.type === 'function_call');
  // Realtime can include assistant text alongside a required tool call. Discard
  // that text entirely; only the single validated tool can become an intent.
  if (calls.length !== 1 || response.output.some(item => !['function_call', 'reasoning'].includes(item.type) && !isAssistantText(item))) {
    throw new Error('Cloud voice must return exactly one proposal. Nothing was executed.');
  }
  const call = calls[0];
  if (call.status !== undefined && call.status !== 'completed') throw new Error('Cloud voice did not complete a command proposal.');
  if (typeof call.arguments !== 'string' || call.arguments.length > 4096) throw new Error('Invalid cloud voice proposal.');
  let args;
  try { args = JSON.parse(call.arguments); } catch { throw new Error('Invalid cloud voice proposal.'); }
  return decodeCall(call.name, args, context, contract);
}

function interpretAudio({ audio, context, apiKey, contract, signal, WebSocketClass = null, deadlineMs = DEADLINE_MS, modelId = MODEL }) {
  if (modelId !== MODEL) return Promise.reject(cloudError('CLOUD_MODEL'));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Cloud voice cancelled.')); return; }
    const Socket = WebSocketClass || require('ws');
    let socket;
    let settled = false;
    let configured = false;
    let submitted = false;
    let receivedBytes = 0;
    const timer = setTimeout(() => finish(Object.assign(new Error('Cloud voice timed out.'), { code: 'CLOUD_TIMEOUT' })), deadlineMs);
    const abort = () => finish(new Error('Cloud voice cancelled.'));
    function finish(error, result = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (socket) { try { socket.terminate(); } catch {} }
      if (error) reject(error); else resolve(result);
    }
    function send(event) { socket.send(JSON.stringify(event)); }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      socket = new Socket(`wss://api.openai.com/v1/realtime?model=${modelId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        handshakeTimeout: deadlineMs, maxPayload: 262144, perMessageDeflate: false, followRedirects: false,
      });
      socket.on('error', () => finish(providerError()));
      socket.on('unexpected-response', (_request, response) => { response.resume?.(); finish(providerError(response.statusCode)); });
      socket.on('close', () => finish(new Error('Cloud voice connection closed before a result. Nothing was executed.')));
      socket.on('message', data => {
        if (settled) return;
        try {
          receivedBytes += data.length;
          if (receivedBytes > 524288) throw new Error('Cloud voice response was too large.');
          const event = JSON.parse(data.toString());
          if (event.type === 'session.created' && !configured) {
            configured = true;
            send({ type: 'session.update', session: {
              type: 'realtime', output_modalities: ['text'],
              audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null } },
              instructions: instructionsForContext(context),
              tools: toolsForContext(context), tool_choice: 'required', max_output_tokens: 512,
            } });
          } else if (event.type === 'session.updated' && configured && !submitted) {
            submitted = true;
            // A fresh connection owns exactly one released utterance, with no history.
            send({ type: 'input_audio_buffer.append', audio: audio.toString('base64') });
            send({ type: 'input_audio_buffer.commit' });
            send({ type: 'response.create' });
          } else if (event.type === 'error') {
            // Realtime can reject authentication after the WebSocket opens.
            // Classify known codes/types without exposing the provider payload.
            const code = event.error?.code;
            const status = code === 'invalid_api_key' ? 401
              : code === 'rate_limit_exceeded' || code === 'insufficient_quota' ? 429
                : event.error?.type === 'invalid_request_error' ? 400 : undefined;
            finish(providerError(status));
          } else if (event.type === 'response.done' && submitted) {
            const intent = decodeProposal(event.response, context, contract);
            const usage = event.response.usage;
            finish(null, { intent, usage: {
              inputTokens: Number.isSafeInteger(usage?.input_tokens) ? usage.input_tokens : 0,
              outputTokens: Number.isSafeInteger(usage?.output_tokens) ? usage.output_tokens : 0,
            } });
          }
        } catch { finish(cloudError('CLOUD_INVALID')); }
      });
    } catch { finish(providerError()); }
  });
}

module.exports = { MODEL, DEADLINE_MS, toolsForContext, decodeProposal, interpretAudio };
