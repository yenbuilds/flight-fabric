# Flight Fabric 0.7.0

Flight Fabric 0.7.0 adds a dedicated aircraft-specific command and offline
voice catalogue for the free FlyByWire A32NX. Its reviewed beta surface uses
FlyByWire's documented fixed custom client events and the same profile-aware,
fail-closed command pipeline as visible aircraft controls.

## Added

- The FlyByWire A32NX profile exposes a dedicated 26-command catalogue for
  speed/Mach, heading, altitude, vertical speed/FPA, managed and selected FCU
  modes, AP1/AP2, captain flight director, autothrust, LOC, APPR, EXPED,
  forward throttle detents, standard gear and flap steps, parking brake,
  spoiler arming, selected exterior lights, and the takeoff-light preset.
- FCU targets use only fixed adapter-owned `A32NX.FCU_*` custom client events.
  Speed/Mach and vertical-speed/FPA commands require a fresh matching selector
  mode before dispatch, and changed targets require newer logical readback.
- Local push-to-talk voice recognition understands A32NX terminology including
  AP one/two, autothrust, managed and selected modes, FPA, LOC, APPR, EXPED,
  throttle detents, spoilers, and selected exterior-light positions.
- Existing executable A32NX gear and relative-flap commands remain available;
  the dedicated catalogue adds reviewed aircraft-specific routes without
  enabling the profile's intentionally disabled generic autopilot fallback.

## Download

- `Flight.Fabric.Setup.0.7.0.exe`
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
- FlyByWire A32NX aircraft-specific writes remain an explicitly labelled beta
  pending live validation against current Stable and Development aircraft
  builds. The new FCU routes use documented SimConnect custom client events;
  unsupported native InputEvent/B-var routes remain disabled.
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
