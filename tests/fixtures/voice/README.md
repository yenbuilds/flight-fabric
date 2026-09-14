# NAV speech regression audio

These WAV files contain “Set nav radios one zero nine decimal five” and
“Set nav radios one zero nine point five.” They were synthesized locally with
Windows SAPI, Microsoft David Desktop (English, United States), rate 0,
22,050 Hz mono PCM, 16 bits per sample. NAV uses the SAPI pronunciation
`<pron sym="n ae v">nav</pron>` so it is spoken as a word.

The pinned Zipformer model with eight active decoder paths transcribes the
prefix as “SET IN A RADIOS” on both recordings. Sixteen paths preserve the
complete NAV command. The native regression in `electron/voice-runtime.test.js`
decodes both recordings through the production engine and follows them with
silence to check session isolation and false command output.

Run `npm run test:voice` after installing Electron dependencies and provisioning
the pinned voice model. The acoustic test skips when those optional build inputs
are absent or the platform is not Windows x64. These synthetic samples do not
replace microphone and accent testing.
