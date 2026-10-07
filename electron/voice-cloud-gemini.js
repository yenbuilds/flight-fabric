'use strict';

const { DEADLINE_MS, proposalTools, decodeCall, instructionsForContext, cloudError, providerError } = require('./voice-cloud-contract');
const MODEL = 'gemini-3.8-flash';
const MAX_RESPONSE_BYTES = 524288;

function wav24k(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
function requestBody(audio, context) {
  return {
    systemInstruction: { parts: [{ text: instructionsForContext(context) }] },
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: wav24k(audio).toString('base64') } }] }],
    tools: [{ functionDeclarations: proposalTools(context).map(({ name, description, parameters }) => ({ name, description, parametersJsonSchema: parameters })) }],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    generationConfig: { candidateCount: 1, maxOutputTokens: 512, thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: false } },
    store: false,
  };
}
function decodeProposal(response, context, contract) {
  if (response?.promptFeedback?.blockReason || !Array.isArray(response?.candidates) || response.candidates.length !== 1) throw cloudError('CLOUD_INVALID');
  const candidate = response.candidates[0];
  const parts = candidate.content?.parts;
  if (candidate.finishReason !== 'STOP' || !Array.isArray(parts) || parts.length !== 1
      || !parts[0]?.functionCall || Object.keys(parts[0]).some(key => !['functionCall', 'thoughtSignature'].includes(key))) throw cloudError('CLOUD_INVALID');
  const call = parts[0].functionCall;
  if (Object.keys(call).some(key => !['name', 'args', 'id'].includes(key)) || JSON.stringify(call.args)?.length > 4096) throw cloudError('CLOUD_INVALID');
  return decodeCall(call.name, call.args, context, contract);
}

async function interpretAudio({ audio, context, apiKey, contract, signal, modelId = MODEL, fetchImpl = globalThis.fetch, deadlineMs = DEADLINE_MS }) {
  if (modelId !== MODEL) throw cloudError('CLOUD_MODEL');
  if (signal?.aborted) throw cloudError('CLOUD_CANCELLED');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let timedOut = false;
  let reader;
  let rejectAborted;
  const aborted = new Promise((_resolve, reject) => { rejectAborted = reject; });
  controller.signal.addEventListener('abort', () => rejectAborted(cloudError(timedOut ? 'CLOUD_TIMEOUT' : 'CLOUD_CANCELLED')), { once: true });
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
  try {
    return await Promise.race([aborted, (async () => {
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(requestBody(audio, context)),
      });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw cloudError('CLOUD_CANCELLED'); }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw providerError(response.status); }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { void response.body?.cancel().catch(() => {}); throw cloudError('CLOUD_INVALID'); }
      reader = response.body?.getReader();
      if (!reader) throw cloudError('CLOUD_INVALID');
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw cloudError('CLOUD_CANCELLED');
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw cloudError('CLOUD_INVALID');
        chunks.push(Buffer.from(value));
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const intent = decodeProposal(result, context, contract);
      const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
      return { intent, usage: {
        inputTokens: count(result.usageMetadata?.promptTokenCount),
        outputTokens: count(result.usageMetadata?.candidatesTokenCount) + count(result.usageMetadata?.thoughtsTokenCount),
      } };
    })()]);
  } catch (error) {
    // Fetch errors and response bodies can contain URLs, credentials or payloads.
    const codes = ['CLOUD_AUTH', 'CLOUD_QUOTA', 'CLOUD_CONNECTION', 'CLOUD_REQUEST', 'CLOUD_INVALID', 'CLOUD_TIMEOUT', 'CLOUD_CANCELLED'];
    throw cloudError(timedOut ? 'CLOUD_TIMEOUT' : signal?.aborted ? 'CLOUD_CANCELLED' : codes.includes(error?.code) ? error.code : 'CLOUD_FAILED');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}
module.exports = { MODEL, requestBody, decodeProposal, interpretAudio, wav24k };
