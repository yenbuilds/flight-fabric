# Flight Fabric 0.2.7

Flight Fabric 0.2.7 is a documentation release. It replaces the repository
README with a clearer introduction for new users and adds real product
screenshots to the versioned public source.

The desktop app's telemetry, analysis, scoring, storage, and runtime behaviour
are unchanged from 0.2.6.

This publication includes the versioned source and the verified Windows Setup
installer. The portable executable is intentionally not published.

## Highlights

- The README now begins with a concise description, a direct Windows download,
  and an animated tour of live telemetry, aircraft pages, SimBrief, Timeline
  replay, and landing analysis.
- The tour uses the newer Timeline replay and landing debrief captures, changes
  scenes at a readable pace, and remains small enough for a repository landing
  page.
- Installation, trusted LAN access, OBS widgets, and source build instructions
  are easier to find without putting technical and legal material ahead of the
  product overview.
- The animation and its source images are included with the public source, so
  they remain available without exposing the private website source tree.

## Download

- `Flight Fabric Setup 0.2.7.exe` - Windows installer.

The portable `Flight Fabric 0.2.7.exe`, installer blockmap, and
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
