# Flight Fabric 0.3.0

Flight Fabric 0.3.0 expands aircraft controls and improves landing analysis.

## Highlights

- New Fenix A319, A320, and A321 controls, including AP1, AP2, A/THR, LOC,
  APPR, EXPED, managed and selected modes, and typed FCU targets.
- Expanded Microsoft and iniBuilds A330 controls for flight guidance, FCU
  targets, lights, gear, flaps, parking brake, and spoilers.
- A new experimental iniBuilds L-1011-500 page with AFCS, light, selector, and
  three engine controls and monitoring.
- More controls for FlyByWire A32NX and unmatched MSFS aircraft.
- A responsive aircraft control finder with keyboard navigation.
- Shared touchdown rate bands for transport aircraft at 150, 300, 400, and
  600 fpm. Other landing factors are still assessed separately.
- Safer current rules rescoring, including automatic refresh of derived landing
  data when scoring rules change.
- Stronger release packaging checks to prevent incomplete builds.

## Download

- `Flight Fabric Setup 0.3.0.exe`
- `Flight Fabric 0.3.0.exe`
- `SHA256SUMS.txt`

Flight Fabric is unsigned experimental alpha software for consumer flight
simulators. It is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world decisions. Windows may show an **Unknown
publisher** warning.

## Known limitations

- New aircraft controls are still experimental and may need adjustment after
  aircraft updates.
- Fenix vertical speed and FPA editing remain read only.
- The A330 does not yet expose separate AP1 and AP2 controls, managed mode
  push and pull, EXPED, or deeper aircraft systems.
- Current rules rescoring updates completed landing analysis without changing
  the recorded flight.
- Microsoft Flight Simulator 2024 is the supported simulator. MSFS 2020 and
  X-Plane are not currently supported.

See `README.md`, `SAFETY-NOTICE.md`, `LICENSE.md`, and
`THIRD_PARTY_NOTICES.md` for requirements, safety information, licence terms,
and third-party notices.
