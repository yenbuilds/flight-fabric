# Flight Fabric 0.8.1

Flight Fabric 0.8.1 is a focused reliability patch for maps, saved-flight
Timelines, and landing-history accuracy.

## Fixed

- Live View and Replay View use Leaflet's standard OpenStreetMap raster
  basemap, including city and place labels. This removes the failed
  OpenFreeMap/MapLibre bridge and the first-render transition race while
  retaining visible OpenStreetMap attribution.
- Timeline Replay now accepts matching responses from compatible locally
  running backends and always leaves its loading state after a rendering
  failure, so the first flight selection no longer needs a close-and-reopen.
- Missing, zero, or non-descending conventional touchdown vertical speed stays
  unavailable instead of becoming a fabricated `0 fpm`/`PERFECT` landing.
  This applies consistently to live landing cards, Timeline, Logbook, indexed
  history, aggregate statistics, trends, and rescored analysis.

## Download

- `Flight.Fabric.Setup.0.8.1.exe`
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
- Online maps use OpenStreetMap's community tile service for ordinary
  interactive viewing. The service is best effort; Flight Fabric does not
  prefetch or provide offline tiles, and online map traffic can be disabled in
  Settings.
- Microsoft Flight Simulator 2024 is the supported simulator. MSFS 2020 and
  X-Plane are not currently supported.

See `README.md`, `SAFETY-NOTICE.md`, `LICENSE.md`, and
`THIRD_PARTY_NOTICES.md` for requirements, safety information, licence terms,
and third-party notices.
