# Flight Fabric 0.8.0

Flight Fabric 0.8.0 adds a read-only PMDG 777 Flight Guidance lane to saved
flight Timelines and repairs the Live and Replay map basemaps affected in
0.7.0. The new Timeline interpretation uses recorded, fresh PMDG SDK fields
and does not add any aircraft-control writes.

## Added

- Saved PMDG 777 flights can show stable AP and A/T arm changes; LNAV, VNAV,
  FLCH, HDG/TRK HOLD, V/S/FPA, ALT HOLD, LOC, and APP selections; heading and
  vertical-reference changes; and selected MCP speed, Mach, heading, altitude,
  vertical-speed, and flight-path-angle target changes with before/after
  values.
- Flight-guidance changes appear in their own violet Timeline lane and optional
  map layer, with nearby phase and radio-altitude context when recorded flight
  telemetry provides it.
- Mode wording remains deliberately conservative. For example, the Timeline
  reports `LOC selected` or `APP selected`; it does not claim capture from an
  SDK selector field.
- Existing recorded PMDG 777 flights are interpreted from their canonical
  aircraft-specific sidecar when the required trusted SDK fields were saved.
  The generic Timeline and CSV services use an aircraft projection registry;
  PMDG-specific interpretation remains inside the PMDG 777 integration.

## Fixed

- Live View and Replay View again render their OpenFreeMap basemaps. The
  bundled MapLibre runtime is pinned to the Leaflet bridge's compatible major
  version instead of the incompatible runtime shipped in 0.7.0.
- Both independent Leaflet maps now switch once to a simplified OpenFreeMap
  Natural Earth raster fallback if the vector basemap cannot start or load.
  Removal and teardown guard queued bridge callbacks from touching a disposed
  map.
- Replay View refits the retained flight path after its map viewport changes,
  preventing a valid route from being left outside the visible map after the
  Timeline layout settles.

## Download

- `Flight.Fabric.Setup.0.8.0.exe`
- `SHA256SUMS.txt`

Only the installer and `SHA256SUMS.txt` are release downloads. The portable
executable remains a local build and verification artifact and is not
published.

Flight Fabric is unsigned experimental alpha software for consumer flight
simulators. It is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world decisions. Windows may show an **Unknown
publisher** warning.

## Known limitations

- The Flight Guidance lane is currently limited to the PMDG 777-300ER,
  777-200ER, 777-200LR, and 777F profiles. It appears only when the recording
  contains fresh, connected PMDG SDK data; unavailable fields are omitted
  rather than inferred.
- Voice recognition remains Windows-desktop-only, push-to-talk-only, off by
  default, and limited to the exact commands advertised for the active
  aircraft. It is not an always-listening assistant.
- Fenix A32X FCU and virtual-throttle write routes remain marked untested. Do
  not move the same physical FCU rotary while a typed target is pending. Fenix
  FCU writes require a compatible MobiFlight Event Module connection.
- PMDG 737 and 777 controls remain guarded but require the matching installed
  aircraft and reviewed SDK availability. PMDG data broadcast and the SDK
  integration must be available; excluded controls remain unavailable.
- Online maps depend on OpenFreeMap availability. The raster fallback is a
  simplified world basemap and intentionally provides less local detail than
  the primary vector style. Online map traffic can be disabled in Settings.
- Microsoft Flight Simulator 2024 is the supported simulator. MSFS 2020 and
  X-Plane are not currently supported.

See `README.md`, `SAFETY-NOTICE.md`, `LICENSE.md`, and
`THIRD_PARTY_NOTICES.md` for requirements, safety information, licence terms,
and third-party notices.
