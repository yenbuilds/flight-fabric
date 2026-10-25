'use strict';

const VOICE_HOTWORDS = Object.freeze({
  bytes: 6819,
  sha256: 'B7EAD46235A11D12920C429B478E036705E25A0AD1B103A731B6C4A941617A93',
});

const ZIPFORMER_UPSTREAM_REVISION = '9a65b6ea94c311ca770c2bf895b30f456a22d703';
const ZIPFORMER_UPSTREAM_REPOSITORY =
  'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-21';

const ZIPFORMER_MODEL = Object.freeze({
  id: 'sherpa-onnx-streaming-zipformer-en-2023-06-21',
  displayName: 'Zipformer English LibriSpeech + GigaSpeech (INT8)',
  engineVersion: '1.13.5',
  license: 'Apache-2.0',
  sampleRate: 16_000,
  upstream: Object.freeze({
    repositoryUrl: ZIPFORMER_UPSTREAM_REPOSITORY,
    revision: ZIPFORMER_UPSTREAM_REVISION,
    resolveUrl: `${ZIPFORMER_UPSTREAM_REPOSITORY}/resolve/${ZIPFORMER_UPSTREAM_REVISION}/`,
  }),
  obsoleteFiles: Object.freeze(['hotwords.txt']),
  components: Object.freeze({
    encoder: 'encoder-epoch-99-avg-1.int8.onnx',
    decoder: 'decoder-epoch-99-avg-1.onnx',
    joiner: 'joiner-epoch-99-avg-1.int8.onnx',
    tokens: 'tokens.txt',
    bpeVocab: 'bpe.vocab',
  }),
  files: Object.freeze([
    Object.freeze({ name: 'decoder-epoch-99-avg-1.onnx', bytes: 2_092_566, sha256: '9DA02B77CB08826756EC6A88635F35A40374E4164E7C6359121A9145958A6CEB', source: 'upstream' }),
    Object.freeze({ name: 'encoder-epoch-99-avg-1.int8.onnx', bytes: 187_823_992, sha256: '32C98281C7BD8B63E3E142D007251B37F120572E8FDEA9A4F5A79CE22B10EC4F', source: 'upstream' }),
    Object.freeze({ name: 'joiner-epoch-99-avg-1.int8.onnx', bytes: 259_335, sha256: '831477D390E59A61F1B6A6F763B9903E6C6366FF6034F1DDBA613BE82637122F', source: 'upstream' }),
    Object.freeze({ name: 'bpe.vocab', bytes: 12_590, sha256: 'F191A4935F668FA8CD8E607BCD378404F948321CD3134A5EA13D324BA921673D', source: 'bundled' }),
    Object.freeze({ name: 'tokens.txt', bytes: 5_048, sha256: '49E3C2646595FD907228B3C6787069658F67B17377C60AEB8619C4551B2316FB', source: 'upstream' }),
  ]),
});

const KOKORO_MODEL = Object.freeze({
  id: 'kokoro-multi-lang-v1_0',
  archiveUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2',
  archiveBytes: 349906910,
  archiveSha256: 'C5F7E2D2CAF082BC1D20FB70334A61D99D20B484500AAD32E7CF84C128EA3298',
  sampleRate: 24000,
  defaultVoice: 'af_heart',
  // IDs match the hash-pinned voice table. Keep earlier US choices valid for
  // saved preferences while presenting a shorter US/UK list to new selections.
  voices: Object.freeze([
    ['af_alloy', 'Alloy', 0], ['af_aoede', 'Aoede', 1], ['af_bella', 'Bella', 2],
    ['af_heart', 'Heart', 3], ['af_jessica', 'Jessica', 4], ['af_kore', 'Kore', 5],
    ['af_nicole', 'Nicole', 6], ['af_nova', 'Nova', 7], ['af_river', 'River', 8],
    ['af_sarah', 'Sarah', 9], ['af_sky', 'Sky', 10], ['am_adam', 'Adam', 11],
    ['am_echo', 'Echo', 12], ['am_eric', 'Eric', 13], ['am_fenrir', 'Fenrir', 14],
    ['am_liam', 'Liam', 15], ['am_michael', 'Michael', 16], ['am_onyx', 'Onyx', 17],
    ['am_puck', 'Puck', 18], ['am_santa', 'Santa', 19],
    ['bf_emma', 'Emma', 21], ['bf_isabella', 'Isabella', 22],
    ['bm_fable', 'Fable', 25], ['bm_george', 'George', 26],
  ].map(([id, name, speakerId]) => Object.freeze({ id, speakerId,
    // The bundled eSpeak runtime selects British English by its voice file
    // name "en"; the BCP-47 alias "en-gb" fails in the pinned native build.
    language: id.startsWith('b') ? 'en' : 'en-us',
    listed: id.startsWith('b') || ['af_heart', 'af_bella', 'am_michael', 'am_puck'].includes(id),
    label: `${name} — ${id.startsWith('b') ? 'UK' : 'US'}, ${id[1] === 'f' ? 'female' : 'male'}` }))),
  files: Object.freeze(require('./kokoro-model-files.json')),
});

module.exports = { KOKORO_MODEL, VOICE_HOTWORDS, ZIPFORMER_MODEL };
