# Flight Fabric 0.4.2

Flight Fabric 0.4.2 adds a phone-friendly virtual throttle for the Fenix A32X
family and refreshes the website and README around the current application.

## Added

- Fenix A319, A320, and A321 pages now offer four large one-tap controls for
  the forward IDLE, CLB, FLX/MCT, and TOGA throttle detents.
- Every detent command sets both virtual levers together and requires fresh,
  independent left and right readback confirmation before reporting success.
- Accepted taps provide a short capability-detected vibration on supported
  Android browsers. The active detent is highlighted from live aircraft data.

## Changed

- The public website now leads with the complete Flight Fabric workflow: live
  telemetry, guarded aircraft controls, full-flight recording, timeline replay,
  and landing debriefs.
- The README now includes a compact animated product tour and current desktop
  screenshots for Overview, Aircraft Controls, Timeline Replay, and Landing
  Debrief.
- Mobile website previews now use current Flight Fabric captures in a modern
  phone presentation.

## Download

- `Flight.Fabric.Setup.0.4.2.exe`
- `SHA256SUMS.txt`

Only the installer and `SHA256SUMS.txt` are release downloads. The portable
executable remains a local build and verification artifact and is not
published.

Flight Fabric is unsigned experimental alpha software for consumer flight
simulators. It is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world decisions. Windows may show an **Unknown
publisher** warning.

## Known limitations

- Fenix A32X FCU and virtual-throttle write routes remain marked untested and
  require a compatible MobiFlight Event Module connection.
- The virtual throttle exposes forward detents only. Reverse thrust, arbitrary
  axis positions, and split-lever targets are intentionally unavailable.
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
