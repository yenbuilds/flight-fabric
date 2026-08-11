# Flight Fabric 0.2.8

Flight Fabric 0.2.8 is a presentation-focused release. It makes the live
telemetry dashboard and landing debrief easier to scan, while preserving the
underlying telemetry, scoring, storage, and flight-analysis behaviour.

This publication includes the versioned source and the verified Windows Setup
installer. The portable executable is intentionally not published.

## Highlights

- Live telemetry cards now have subtle, purpose-built aviation illustrations
  for airspeed, vertical speed, altitude, radio altitude, ground speed,
  heading, crosswind, and fuel.
- Radio altitude now shows a recognizable aircraft-to-terrain range symbol,
  and ground speed uses a clear directional ground-track vector.
- Landing summary cards use distinct metric watermarks, including a growing
  waveform for an unstable approach.
- Detailed landing metrics now highlight hard problems in red and review items
  in amber, with a compact count in the section header; healthy metrics remain
  visually quiet.
- Timeline replay shows the saved aircraft type beside the route when that
  information is available.

## Download

- `Flight Fabric Setup 0.2.8.exe` - Windows installer.

The portable `Flight Fabric 0.2.8.exe`, installer blockmap, and
`SHA256SUMS.txt` are not part of this installer-only publication. The GitHub
release notes provide the Setup installer's SHA-256 checksum directly.

Flight Fabric is unsigned experimental alpha software for consumer flight
simulators. It is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world operations, navigation, training, or safety
decisions. Windows SmartScreen may show an **Unknown publisher** warning. Only
download from the official GitHub release and verify the published SHA-256
checksum before running it.

## LAN security boundary

Remote access is for a trusted private home network. HTTP and WebSocket traffic
is not encrypted. Treat a paired mobile URL like a temporary password, and do
not use remote access on public or shared networks.

## Known limitations

- Current-rules rescoring covers completed landing analysis. It does not alter
  raw observations or re-detect unrelated flight violations.
- Microsoft Flight Simulator 2024 is the supported simulator target. MSFS 2020
  is not tested or supported.
- X-Plane support is experimental and is not currently available in the app.
- Some aircraft reads and controls still need live validation. They remain
  unavailable or marked untested until they are verified in the simulator.
- Local browser widgets remain available, but the retired Live Sharing relay
  and OBS WebSocket automation are not included.

See `README.md`, `SAFETY-NOTICE.md`, `LICENSE.md`, and
`THIRD_PARTY_NOTICES.md` for requirements, safety information, licence terms,
and third-party notices.
