# Flight Fabric 0.6.1

Flight Fabric 0.6.1 extends the shared aircraft-control and offline voice
surface to the Fenix A319/A320/A321 and PMDG 777 families. Matching visible
controls and voice phrases now resolve through the same profile-aware,
fail-closed command catalogue.

## Added

- Fenix A319, A320, and A321 profiles expose one reviewed 20-command catalogue
  for FCU targets and modes, AP1/AP2, autothrust, forward throttle detents,
  parking brake, selected exterior lights, and the takeoff-light preset.
- PMDG 777-300ER, 777-200ER, 777-200LR, and 777F profiles expose one reviewed
  32-command catalogue for MCP targets, AFDS modes and selectors, gear, flaps,
  speedbrake, parking brake, autobrake, selected exterior lights, and the
  takeoff-light preset.
- Matching controls on the dedicated Fenix and PMDG 777 pages use the same
  canonical commands advertised to local push-to-talk voice control. Controls
  outside those reviewed catalogues keep their existing guarded UI-only routes.
- The local voice vocabulary covers Fenix and PMDG 777 terminology including
  managed FCU modes, throttle detents, LNAV, VNAV, FPA, TRK, FLCH, and RTO.
- The README and website include a premium-aircraft matrix for families with
  both extended controls and aircraft-specific voice commands.

## Download

- `Flight.Fabric.Setup.0.6.1.exe`
- `SHA256SUMS.txt`

Only the installer and `SHA256SUMS.txt` are release downloads. The portable
executable remains a local build and verification artifact and is not
published.

Flight Fabric is unsigned experimental alpha software for consumer flight
simulators. It is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world decisions. Windows may show an **Unknown
publisher** warning.

## Known limitations

- Voice recognition remains Windows-desktop-only, push-to-talk-only, off by
  default, and limited to the exact commands advertised for the active
  aircraft. It is not an always-listening assistant.
- Fenix A32X FCU and virtual-throttle write routes remain marked untested. Do
  not move the same physical FCU rotary while a typed target is pending. Fenix
  FCU writes require a compatible MobiFlight Event Module connection.
- PMDG 737 and 777 controls remain guarded but require live validation for the
  installed aircraft version. PMDG data broadcast and the reviewed SDK
  integration must be available; excluded controls remain unavailable.
- Microsoft Flight Simulator 2024 is the supported simulator. MSFS 2020 and
  X-Plane are not currently supported.

See `README.md`, `SAFETY-NOTICE.md`, `LICENSE.md`, and
`THIRD_PARTY_NOTICES.md` for requirements, safety information, licence terms,
and third-party notices.
