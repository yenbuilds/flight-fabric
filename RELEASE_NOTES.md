# Flight Fabric 0.4.4

Flight Fabric 0.4.4 improves mobile session continuity and makes phone pairing
states clearer and safer to recover.

## Changed

- The desktop Phone shortcut remains available at compact desktop widths while
  staying hidden on phone and tablet layouts.
- Phone guidance now distinguishes viewer mode, an expired pairing, and a
  backend session where LAN aircraft controls are not active.

## Fixed

- Pull-to-refresh and full page reloads now restore the last valid active tab,
  including contextual Landing and LVAR inspector views, instead of returning
  to Overview.
- The System page no longer shows a phone URL, copy action, or QR code until
  the running backend confirms that trusted-LAN access is active. A saved
  setting waiting for restart can no longer expose an unusable pairing link.
- Saved Phone links with a token from an earlier backend session now report
  `Pairing expired` and direct the user to scan the current desktop QR.

## Download

- `Flight.Fabric.Setup.0.4.4.exe`
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
