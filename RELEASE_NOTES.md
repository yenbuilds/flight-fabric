# Flight Fabric 0.5.2

Flight Fabric 0.5.2 makes aircraft controls faster to find and easier to use
across desktop and mobile layouts.

## Added

- The PMDG 737 has an optional initial-power quick group for common battery,
  standby-power, bus-transfer, ground-power, APU, IRS, and related overhead
  controls. Commands remain guarded and confirmed against aircraft readback.

## Fixed

- PMDG 737, PMDG 777, Fenix A32X, FlyByWire A32NX, and FlyByWire A380X pages now
  share compact search and section navigation behavior across desktop,
  narrow-window, touch, and mobile layouts.
- Aircraft panel location labels now match their flight-control, APU, and
  related cockpit areas.

## Download

- `Flight.Fabric.Setup.0.5.2.exe`
- `SHA256SUMS.txt`

Only the installer and `SHA256SUMS.txt` are release downloads. The portable
executable remains a local build and verification artifact and is not
published.

Flight Fabric is unsigned experimental alpha software for consumer flight
simulators. It is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world decisions. Windows may show an **Unknown
publisher** warning.

## Known limitations

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
