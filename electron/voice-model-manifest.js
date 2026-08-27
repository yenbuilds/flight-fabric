'use strict';

const VOICE_HOTWORDS = Object.freeze({
  bytes: 1_533,
  sha256: '1FB40C3010A021524FDBBC1803B6D20AB9C066D34B62A340B41B125A8266CEAD',
});

const ZIPFORMER_UPSTREAM_REVISION = '672fbf1b30579d6585301139bb363f42a0ad4a24';
const ZIPFORMER_UPSTREAM_REPOSITORY =
  'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26';

const ZIPFORMER_MODEL = Object.freeze({
  id: 'sherpa-onnx-streaming-zipformer-en-2023-06-26',
  displayName: 'Zipformer English LibriSpeech (INT8)',
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
    encoder: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
    decoder: 'decoder-epoch-99-avg-1-chunk-16-left-128.onnx',
    joiner: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
    tokens: 'tokens.txt',
    bpeVocab: 'bpe.vocab',
  }),
  files: Object.freeze([
    Object.freeze({ name: 'decoder-epoch-99-avg-1-chunk-16-left-128.onnx', bytes: 2_092_621, sha256: '7BF787F90B194B307E5A4AD6A34FADB4E748304C35F78A8D66358A05B13EE6EF', source: 'upstream' }),
    Object.freeze({ name: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx', bytes: 71_083_163, sha256: '563FDE436D16CF7607CF408CD6B30909819D03162652EF389C2450CED3F45AC1', source: 'upstream' }),
    Object.freeze({ name: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx', bytes: 259_335, sha256: 'D944208D660D67C8D72CD2ACAEAC971FA5CEB8C80E76C1968148846FEDD6E297', source: 'upstream' }),
    Object.freeze({ name: 'bpe.vocab', bytes: 12_590, sha256: 'F191A4935F668FA8CD8E607BCD378404F948321CD3134A5EA13D324BA921673D', source: 'bundled' }),
    Object.freeze({ name: 'tokens.txt', bytes: 5_048, sha256: '49E3C2646595FD907228B3C6787069658F67B17377C60AEB8619C4551B2316FB', source: 'upstream' }),
  ]),
});

module.exports = { VOICE_HOTWORDS, ZIPFORMER_MODEL };
