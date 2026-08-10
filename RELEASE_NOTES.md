# Flight Fabric 0.2.6

Flight Fabric 0.2.6 is a focused interface-polish release. It makes the landing
debrief and Timeline summary more consistent, readable, and responsive without
changing flight analysis or scoring behavior.

This publication includes the versioned source and the verified Windows Setup
installer. The portable executable is intentionally not published.

## Highlights

- Landing result labels and values now share one consistent hierarchy and
  alignment, while redundant status text such as the repeated bounce result is
  removed.
- Stability Breakdown, Approach Profile, and Ground Track now start expanded,
  and their higher-contrast headers have clearer hover, focus, and expanded
  states.
- Flight Summary & Events facts are grouped into responsive cards instead of a
  loose inline stream, making the section easier to scan at every width.
- Timeline summary text is larger and wraps into tidy rows on narrow windows,
  avoiding horizontal scrolling while keeping the saved-state control visible.
- These changes are limited to presentation and component coverage; flight
  analysis, scoring, data storage, and backend behavior are unchanged.

## Download

- `Flight Fabric Setup 0.2.6.exe` - Windows installer.

The portable `Flight Fabric 0.2.6.exe`, installer blockmap, and
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
