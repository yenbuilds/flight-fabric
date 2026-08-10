# Flight Fabric 0.2.5

Flight Fabric 0.2.5 is a defensive maintenance release for several runtime edge
cases. It improves cold-start phase detection, low-altitude recording,
settings recovery, legacy profile normalization, and long Timeline sessions.

This publication includes the versioned source and the verified Windows Setup
installer. The portable executable is intentionally not published.

## Highlights

- Starting Flight Fabric during a high-speed runway roll no longer creates a
  false Landing phase without observed touchdown context. The roll remains
  Taxi and can still become Takeoff after liftoff.
- Ultra-fidelity touchdown sampling no longer treats 100 consecutive ordinary
  ticks as a stuck evaluator. The existing 60-second and 600-sample safety caps
  remain authoritative.
- Settings files whose JSON root is null, an array, or another non-object value
  now fall back to complete defaults instead of failing during nested merges.
- Legacy throttle-detent metadata is retired from normalized aircraft profiles
  without modifying the imported profile object.
- Timeline event IDs remain unique after more than 10,000 events, preserving
  unambiguous worst-moment references when older retained events are evicted.
- Published desktop and SDK dependency locks have been refreshed within their
  declared compatibility ranges, and the blocking OSV audit now covers the
  exact lockfiles included in the desktop/source release.

## Download

- `Flight Fabric Setup 0.2.5.exe` - Windows installer.

The portable `Flight Fabric 0.2.5.exe`, installer blockmap, and
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
