# Flight Fabric 0.2.3

Flight Fabric 0.2.3 adds reversible current-rules rescoring for completed
landing analysis, makes approach-stability outcomes easier to understand, and
keeps live and historical results tied to the aircraft that produced them.

This publication includes the versioned source and the verified Windows Setup
installer. The portable executable is intentionally not published.

## Highlights

- Completed flights can preview and save a current-rules analysis for every
  landing in the flight. Touchdown-rate, approach-stability, TDZ,
  lateral-offset, bounce, and rollout results are applied atomically across
  Timeline, Logbook, Recent Flights, and trends.
- Applying a rescore writes one reversible derived snapshot. Restore returns
  every surface to the recorded analysis; raw telemetry, recorder companions,
  and the completion certificate remain unchanged.
- Historical replay and in-progress landing analysis use the recorded or
  touchdown-captured aircraft profile instead of the aircraft currently
  selected in the app. Conventional touchdown V/S remains authoritative;
  simulator touchdown-normal velocity remains diagnostic-only.
- Approach stability now reports Stable, Marginal, Unstable, or No Verdict.
  The strict all-checks audit remains available, while borderline proxy misses
  can be Marginal and the UI shows the leading reasons and percentages.
- Throttle movement uses a cadence-resistant one-second window, and missing
  stability evidence remains unavailable instead of becoming a false 0% score.
- Mobile scrolling no longer reconnects an already healthy WebSocket, and the
  From-to route banner continues updating while the map tab is hidden.
- Correlated Timeline requests prevent late replies from replacing a newer
  selected flight or leaving a matching authorization error stuck.
- Virgin Windows packaging now validates the complete shared runtime, and
  SimBrief ETOPS weather renders all returned METAR and TAF reports.
- Runtime aircraft-profile selection is release-owned and bundled. Retired
  local or community profile files are preserved on disk but ignored, with
  saved local selections migrated back to automatic detection.
- The public telemetry client now exposes the final approach-stability verdict
  to SDK and React consumers alongside its score and breakdown.

## Download

- `Flight Fabric Setup 0.2.3.exe` - Windows installer.

The portable `Flight Fabric 0.2.3.exe`, installer blockmap, and
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
