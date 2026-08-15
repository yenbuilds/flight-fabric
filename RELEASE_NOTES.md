# Flight Fabric 0.4.3

Flight Fabric 0.4.3 adds calibrated FlyByWire virtual throttles and makes the
phone or tablet second-screen path clearer and easier to reuse between flights.

## Added

- FlyByWire A32NX pages now provide large one-tap IDLE, CLB, FLX/MCT, and TOGA
  controls for both virtual throttle levers.
- The FlyByWire A380X page provides the same four forward detents across all
  four levers while preserving one coordinated, fail-closed command.
- Each lever targets the midpoint of its saved FlyPad calibration window and
  requires its own fresh TLA confirmation before Flight Fabric reports success.
- Phone layouts now include a focused second-screen guide covering connection,
  pairing, controls, and recovery.

## Changed

- The desktop System page now presents one clear phone link and QR code. When
  available on the simulator PC, it includes the current backend-session
  aircraft-control pairing instead of asking users to choose between viewer and
  control links.
- Starting a new flight no longer implies another scan. Pairing remains valid
  for the lifetime of the current Flight Fabric backend session and the setup
  copy now explains when a fresh scan is required.
- A compact desktop-only Phone shortcut opens the second-screen setup card;
  the shortcut is intentionally hidden on phone and tablet layouts.
- Flight is now the initial dashboard view instead of Live, including the
  responsive browser experience.

## Fixed

- A380X four-lever detent expressions now cache calibration values in
  calculator registers, keeping the atomic validation and write within the
  MobiFlight ClientData command limit.
- MobiFlight command validation now matches the Event Module protocol: 1,008
  printable calculator bytes plus the required NUL terminator, separate command
  and response definition IDs, a primed command channel, and exact completion
  registration.

## Download

- `Flight.Fabric.Setup.0.4.3.exe`
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
- Legacy Recent Flights entries without recording-start metadata currently
  appear as Recorded at the Unix epoch instead of displaying their saved-file
  time.
- Microsoft Flight Simulator 2024 is the supported simulator. MSFS 2020 and
  X-Plane are not currently supported.

See `README.md`, `SAFETY-NOTICE.md`, `LICENSE.md`, and
`THIRD_PARTY_NOTICES.md` for requirements, safety information, licence terms,
and third-party notices.
