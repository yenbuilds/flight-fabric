# Flight Fabric 0.2.4

Flight Fabric 0.2.4 makes Timeline Replay substantially easier to use when an
event or scoring comparison contains a lot of information. The event list now
remains the primary workspace instead of being squeezed by stacked detail
panels.

This publication includes the versioned source and the verified Windows Setup
installer. The portable executable is intentionally not published.

## Highlights

- Timeline event details now open in a dedicated inspector drawer over the
  replay area, so long flap, configuration, landing, or other event payloads no
  longer consume the event list's vertical space.
- The full current-rules scoring comparison now opens in a separate review
  modal. Multi-landing comparisons remain readable without creating nested
  scroll areas inside the Timeline card.
- The compact Timeline summary keeps the review action and saved-analysis
  status accessible without permanently occupying the lower half of the
  inspector.
- Desktop, fullscreen, keyboard, and mobile layouts share the same coherent
  drawer/modal interaction. Escape closes the active overlay before closing
  Timeline Replay, and focus returns to the control that opened it.
- This is a presentation-only maintenance release. Recorded flight data,
  landing analysis, saved rescoring, and scoring rules are unchanged from
  0.2.3.

## Download

- `Flight Fabric Setup 0.2.4.exe` - Windows installer.

The portable `Flight Fabric 0.2.4.exe`, installer blockmap, and
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
