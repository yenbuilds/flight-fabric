# Flight Fabric 0.2.2

Flight Fabric 0.2.2 moves optional runway-database work out of the critical
approach and touchdown path while preserving finalized landing analysis.

## Highlights

- Runway geometry is no longer queried during approach, touchdown, or active
  rollout capture. Normal go-arounds therefore perform no runway-database load.
- Finalized landings resolve one canonical runway result for the debrief,
  stability score, touchdown-distance analysis, timeline, and logbook.
- A runway miss retains nearby-airport elevation when available, while missing
  runway geometry remains explicitly unavailable instead of being invented.
- The OurAirports CSV fallback uses a single-pass parser that still supports
  quoted multiline records. It remains dormant while the preferred facilities
  provider can answer.
- The live approach runway label is intentionally unavailable until the final
  landing result. WebSocket telemetry framing is unchanged in this release.
- The history index now verifies hardened SQLite connection settings and schema
  integrity. Runtimes without the required defensive mode retain the existing
  CSV history path instead of opening a partially hardened database.
- Desktop profile and saved-history requests now wait for the server-acknowledged
  WebSocket scope, and reconnects discard stale authorization and bootstrap
  results before opening a replacement socket.
- Flight Fabric is licensed under GNU AGPL version 3 only. The app and
  installer link to the corresponding source for each release.

## Downloads

- `Flight Fabric Setup 0.2.2.exe` - Windows installer.
- `Flight Fabric 0.2.2.exe` - portable Windows build.
- `SHA256SUMS.txt` - SHA-256 checksums for both executables.

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

- Microsoft Flight Simulator 2024 is the supported simulator target. MSFS 2020
  is not tested or supported.
- X-Plane support is experimental and is not currently available in the app.
- Some aircraft reads and controls still need live validation. They remain
  unavailable or marked untested until they are verified in the simulator.
- Local browser widgets remain available, but the retired Live Sharing
  relay and OBS WebSocket automation are not included.

See `README.md`, `SAFETY-NOTICE.md`, `LICENSE.md`, and
`THIRD_PARTY_NOTICES.md` for requirements, safety information, licence terms,
and third-party notices.
