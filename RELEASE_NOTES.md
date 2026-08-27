# Flight Fabric 0.6.0

Flight Fabric 0.6.0 adds local offline push-to-talk voice control and brings
visible controls, voice commands, quick presets, and the aircraft command guide
onto one profile-aware, fail-closed command surface.

## Added

- Local offline voice recognition is available in the Windows desktop app.
  Recognition is off by default and starts only after explicit opt-in. While it
  is off, Flight Fabric does not initialize the speech engine or global
  push-to-talk helper, enumerate microphones, or accept recognition sessions.
- Voice commands use only the active aircraft's advertised command catalogue,
  validate bounded values before dispatch, and can provide optional local
  Windows spoken feedback for correlated command results.
- Voice settings can record a supported global push-to-talk shortcut directly.
  The on-screen hold-to-talk control remains available when no shortcut is
  assigned.
- The Aircraft integration guide now combines available commands, reviewed
  quick presets, visible controls, live readbacks, and voice status.

## Fixed

- Aircraft commands and multi-step presets now re-check simulator, profile,
  capability, and readback state at each guarded boundary. Partial or
  unconfirmed execution remains visible and asks the user to verify aircraft
  state instead of claiming success.
- Microphone discovery works on Windows without retaining its temporary stream,
  and microphone permission remains limited to the active bounded voice
  session.
- Live and timeline maps load the OpenFreeMap dark vector basemap through the
  packaged MapLibre runtime, with a local fallback surface when tiles are
  unavailable.
- Consecutive landings retain independent approach-stability results instead of
  inheriting the previous landing's score or failures.
- Landing and logbook trend labels now normalize change across the complete
  comparison window instead of changing sensitivity with sample count.
- Windows-reserved backend ports can recover through a confirmed available port
  pair, while real listeners remain protected by verified ownership checks.
- Narrow desktop and tablet layouts keep the compact header, and packaged
  Windows builds apply explicit Flight Fabric taskbar identity and icon
  metadata.
- Generic fallback aircraft controls and readbacks identify their limited scope
  clearly and keep unavailable or unsupported commands fail-closed.

## Download

- `Flight.Fabric.Setup.0.6.0.exe`
- `SHA256SUMS.txt`

Only the installer and `SHA256SUMS.txt` are release downloads. The portable
executable remains a local build and verification artifact and is not
published.

Flight Fabric is unsigned experimental alpha software for consumer flight
simulators. It is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world decisions. Windows may show an **Unknown
publisher** warning.

## Known limitations

- Voice recognition is Windows-desktop-only, push-to-talk-only, and limited to
  the exact commands advertised for the active aircraft. It is not an
  always-listening assistant and does not interpret unrestricted speech.
- The FlyByWire A32NX and A380X write routes remain marked untested pending
  live validation in current aircraft releases and require a compatible
  MobiFlight Event Module connection.
- FlyByWire virtual throttles expose only the four forward detents. Invalid or
  missing calibration, reverse thrust, sliders, arbitrary axis positions, and
  split-lever targets fail closed or remain unavailable.
- The phone link is private and works only on the same trusted network. Its
  aircraft-control pairing expires when the Flight Fabric backend restarts,
  and aircraft commands still require the LAN control setting.
- Fenix A32X FCU and virtual-throttle write routes remain marked untested. Do
  not move the same physical FCU rotary while a typed target is pending.
- PMDG 737 and 777 controls remain guarded but require live validation for the
  installed aircraft version; unavailable, maintenance, emergency, door, and
  momentary controls stay excluded.
- Legacy Recent Flights entries without recording-start metadata currently
  appear as Recorded at the Unix epoch instead of displaying their saved-file
  time.
- Microsoft Flight Simulator 2024 is the supported simulator. MSFS 2020 and
  X-Plane are not currently supported.

See `README.md`, `SAFETY-NOTICE.md`, `LICENSE.md`, and
`THIRD_PARTY_NOTICES.md` for requirements, safety information, licence terms,
and third-party notices.
