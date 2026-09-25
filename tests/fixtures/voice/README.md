# Voice recognition regression audio

## NAV radio commands

These WAV files contain “Set nav radios one zero nine decimal five” and
“Set nav radios one zero nine point five.” They were synthesized locally with
Windows SAPI, Microsoft David Desktop (English, United States), rate 0,
22,050 Hz mono PCM, 16 bits per sample. NAV uses the SAPI pronunciation
`<pron sym="n ae v">nav</pron>` so it is spoken as a word.

The previous LibriSpeech-only Zipformer model with eight active decoder paths transcribes the
prefix as “SET IN A RADIOS” on both recordings. Sixteen paths preserve the
complete NAV command. The native regression in `electron/voice-runtime.test.js`
decodes both recordings through the production engine and follows them with
silence to check session isolation and false command output.

Run `npm run test:voice` after installing Electron dependencies and provisioning
the pinned voice model. The acoustic test skips when those optional build inputs
are absent or the platform is not Windows x64. These synthetic samples do not
replace microphone and accent testing.

## APU endings and heading digits

The `apu-start-{david,zira}.wav`, `apu-incomplete-{david,zira}.wav`, and
`heading-270-{david,zira}.wav` files contain, respectively, "start A P U",
"start A P", and "set heading two seven zero". They were synthesized locally
for the 2026-09-10 acronym review using Windows SAPI Microsoft David/Zira Desktop
(English, United States), default rate, 16,000 Hz mono PCM, 16 bits per sample.
They contain no microphone recordings.

The native test removes only trailing samples that are exactly zero, preserves
every non-zero sample, and appends 250 ms of silence to represent the existing
captured release tail. Four leading-silence offsets (0, 80, 160, and 240 ms)
exercise different model chunk alignments. The complete commands must retain
their final letter/digit; incomplete APU phrases must remain incomplete.

These 24 variants, two NAV fixtures, and one silence input all run through the
production speech engine. The partial-APU cases catch a proposed increase in
decoder silence padding that sometimes inserts an unspoken U. See the
[recognition review](../../../docs/VOICE-RECOGNITION-REVIEW-2026-09-23.md) for
measured results, remaining gaps, and the difference between recorded audio
and internal decoder padding.

## LibriSpeech + GigaSpeech migration

The 2026-09-23 migration retains the checks above and adds
`heading-070-{david,zira}.wav` ("set heading zero seven zero") and
`heading-incomplete-{david,zira}.wav` ("set heading two seven"). These were
synthesized on that date with the same Windows SAPI voices, default rate and
16,000 Hz mono PCM16 format. They contain no microphone recordings.

Each uses the same four leading-silence offsets and 250 ms trailing silence.
The leading-zero heading must remain complete. The incomplete heading must be
rejected by the production command interpreter, so neither an inserted zero
nor an incorrectly accepted heading 27 can pass. The follow-up silence review
adds empty input, one/three-second digital silence, 48 kHz digital silence and
speech after silent sessions; every silent partial and final must remain empty.
Together the native test now decodes 48 inputs. These cases exercise the changed ZERO/TWO vocabulary scores;
they are not a general recognition-accuracy guarantee. See the
[regression review](../../../docs/ZIPFORMER-MODEL-COMPARISON-2026-09-23.md#regression-review).
