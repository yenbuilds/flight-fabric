'use strict';

const VOICE_HOTWORDS = Object.freeze({
  bytes: 6735,
  sha256: '6AF94DAFB9F8E781D9CE15A280BF98C3284B2E334B44C3FE4CEBED61F7DE92F8',
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

module.exports = { VOICE_HOTWORDS, ZIPFORMER_MODEL };
