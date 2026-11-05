# Voice recognition regression audio

## Engage word hint — 5 November 2026

The production vocabulary adds `ENGAGE :1.5`, preserving all existing hints and
scores. All eight retained `engage approach` cases now decode correctly; bare
`engage` remains incomplete. See the [comparison and limitations](../../../docs/VOICE-RECOGNITION-REVIEW-2026-09-23.md#engage-word-hint--5-november-2026).

The short-command manifest now contains **94 WAV files / 375 inputs**. The added
16 files cover word/spelled LNAV and VNAV, `engage`, `engage a`, and negated
LNAV/VNAV in both David/Zira voices at four alignments. They use the same local
SAPI settings below and contain no microphone recordings. Existing assertions
remain unchanged. The outer native test timeout accommodates the larger corpus;
per-input audio and finalization deadlines are unchanged.

## Bounded number-word hints — 4 November 2026

At this stage the production vocabulary added natural number/unit hints while
retaining all earlier command-specific scores. It fixed 34 of the 42 original failures;
the eight `engage approach` variants still failed. No assertion was skipped or
weakened. See the [current comparison and limitations](../../../docs/VOICE-RECOGNITION-REVIEW-2026-09-23.md#bounded-number-word-hints--4-november-2026).

The existing manifest now contains **78 WAV files / 311 inputs**. The added
24 files retain twelve phrases from a fresh before/after comparison: altitudes
11,000/14,000/17,000/37,000, lighting 40%/90%, Mach 0.82, negated approach/altitude,
compound altitude/lighting-and-gear requests, and unrelated percentage speech.
Their expectations require the exact command and value, or no executable match.
They use the same local David/Zira SAPI settings documented below and contain
no microphone recordings. All 96 new cases passed on the selected vocabulary.

## Short commands and natural numbers — 2 November 2026

**Historical status — 3 November rollback:** production vocabulary was restored to
the pre-retune scores, including the earlier lighting aliases. The native test
retains all 54 files / 215 inputs and now reports each input as a separate subtest,
so a number failure cannot prevent later Mach/RTO/barometer checks from running.
It still asserts the intended command and value; no known failures are skipped,
deferred, or converted into accepted output. Raw ending checks normalize the
equivalent spellings `per cent` and `percent` without repairing number words.

All 23 formerly passing Mach/RTO/barometer cases and 16 incomplete cases pass
after rollback. The 42 failures in the original accuracy corpus match the frozen
pre-retune results exactly, including number/ending errors and "engage approach".
These are unresolved baseline problems, not evidence of a new accuracy fix.
See [rollback validation](../../../docs/VOICE-RECOGNITION-REVIEW-2026-09-23.md#vocabulary-rollback--3-november-2026).

The ten fixtures added during the 3 November review contain Mach 0.78, autobrake
RTO, barometer-standard speech and incomplete RTO/barometer phrases. The Zira RTO
fixture lists the three alignments that passed before tuning; its 240 ms alignment
already failed with the earlier hints and remains a documented gap. Other fixtures
use all four offsets.

The original 44 WAV files in `short-commands/manifest.json` were synthesized with
Microsoft David/Zira Desktop (English, United States), Windows SAPI, rate 0,
48,000 Hz mono PCM16. They contain no microphone recordings. `spoken` records
the complete source phrase; `expected` records the actual aircraft command and
target, or `null` for unfinished commands and unrelated speech.

The original 44-fixture test preserves every non-zero sample, removes only SAPI's
trailing digital silence, and adds the current 500 ms capture tail. Four offsets
(0/80/160/240 ms) produce 176 inputs under five seconds. It sends production
2048-frame worklet chunks through the real engine, awaiting worker acknowledgements
to avoid an artificial queue overrun during accelerated replay. It checks the
real PMDG 737/Fenix catalogues without executing any simulator action. The reported
number endings also have raw-transcript assertions, so parser corrections cannot
hide a decoder regression. Existing APU/NAV/heading/silence fixtures remain separate.

Before the vocabulary change, the new regression failed with `ALTITUDE ZERO`
for "altitude thirteen thousand". The rejected lower-boost experiment restored
the complete numeric phrases in these fixtures but regressed other commands;
rollback restores the original numeric failures too. The full isolated
comparison also retained three phrases with known rejections (heading 280/290
and "turnoff lights off"); these are documented as remaining gaps rather than
weakened passing assertions. See the
[short-command investigation](../../../docs/VOICE-RECOGNITION-REVIEW-2026-09-23.md#short-command-number-distortion--2-november-2026).

Synthetic voices demonstrate repeatable regressions; they do not establish
headset, accent or simulator-noise accuracy.

## NAV radio commands

These WAV files contain “Set nav radios one zero nine decimal five” and
“Set nav radios one zero nine point five.” They were synthesized locally with
Windows SAPI, Microsoft David Desktop (English, United States), rate 0,
22,050 Hz mono PCM, 16 bits per sample. NAV uses the SAPI pronunciation
`<pron sym="n ae v">nav</pron>` so it is spoken as a word.

The previous LibriSpeech-only Zipformer model with eight active decoder paths transcribes the
prefix as “SET IN A RADIOS” on both recordings. Sixteen paths preserve the
complete NAV command. The native regression in `electron/tests/voice-runtime.test.js`
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

**2 November 2026 update:** the native regression now repeats the APU/heading
fixtures with both the historical 250 ms and the current 500 ms captured release tail.
This adds 40 variants (88 inputs total), checking complete and intentionally
incomplete phrases against the unchanged 500 ms decoder padding. The production
PTT tail is now 500 ms; descriptions below retain the original migration evidence.

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
