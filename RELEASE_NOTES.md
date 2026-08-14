# Flight Fabric 0.4.1

Flight Fabric 0.4.1 fixes Fenix A32X numeric FCU targeting and makes published
checksum verification work with the exact GitHub installer filename.

## Fixed

- Fenix A32X typed speed, heading, and altitude values are now treated as
  absolute targets. Flight Fabric sends one relative knob detent at a time and
  waits for exact aircraft progress before continuing, with bounded step and
  time limits.
- Missing, stale, skipped, wrong-direction, profile-changing, or timed-out FCU
  progress stops the sequence without sending another unconfirmed step. A
  timeout can leave the selector at an intermediate value.
- Published SHA-256 checksum files now reference the exact dotted GitHub
  installer asset name, so normal filename-based verification works without
  renaming the download.

## Download

- `Flight.Fabric.Setup.0.4.1.exe`
- `SHA256SUMS.txt`

Only the installer and `SHA256SUMS.txt` are release downloads. The portable
executable remains a local build and verification artifact and is not
published.

Flight Fabric is unsigned experimental alpha software for consumer flight
simulators. It is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world decisions. Windows may show an **Unknown
publisher** warning.

## Known limitations

- Fenix A32X FCU write routes remain marked untested and require the MobiFlight
  Event Module.
- Do not move the same physical Fenix FCU rotary while a typed target is
  pending. The transport cannot distinguish that cockpit detent from app
  progress.
- Legacy Recent Flights entries without recording-start metadata currently
  appear as Recorded at the Unix epoch instead of displaying their saved-file
  time.
- Microsoft Flight Simulator 2024 is the supported simulator. MSFS 2020 and
  X-Plane are not currently supported.

See `README.md`, `SAFETY-NOTICE.md`, `LICENSE.md`, and
`THIRD_PARTY_NOTICES.md` for requirements, safety information, licence terms,
and third-party notices.
