# Flight Fabric 0.4.0

Flight Fabric 0.4.0 expands guarded aircraft controls and adds clearer aircraft,
wind, and time context to landing debriefs and Timeline replay.

## Highlights

- New experimental guarded aircraft pages for the FlyByWire A380X, the
  Microsoft/iniBuilds A320neo V2 and A321LR, and the included Microsoft/Asobo
  Studio Boeing 737 MAX 8.
- More reliable FlyByWire A380X detection, including the current A380-842 and
  no-cabin title and package-path variants.
- Original unbranded aircraft artwork across Landing, Scored Landings, Recent
  Flights, and Timeline, with conservative matching and generic fallbacks.
- Landing debriefs now show touchdown wind direction, speed, and signed
  runway-relative crosswind, including a compass display and an approach-view
  airflow vector when runway heading is available.
- Replayed crosswind now uses the saved landing component or derives it from
  recorded wind and resolved runway heading instead of presenting an
  aircraft-heading-relative sample as runway context.
- Recent Flights entries with recording-start metadata prefer that time over
  file-save time. Timeline replay distinguishes simulator-local and
  simulator-UTC time, and mobile replay adds a shortcut to the latest landing
  debrief.
- The README and public site now describe Flight Fabric consistently as an
  airline-flying companion for Microsoft Flight Simulator 2024.

## Download

- `Flight Fabric Setup 0.4.0.exe`
- `SHA256SUMS.txt`

Only the installer and `SHA256SUMS.txt` are release downloads. The portable
executable remains a local build and verification artifact and is not
published.

Flight Fabric is unsigned experimental alpha software for consumer flight
simulators. It is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world decisions. Windows may show an **Unknown
publisher** warning.

## Known limitations

- The new A380X, A320neo V2, A321LR, and 737 MAX 8 controls remain untested in
  the simulator and may need adjustment after aircraft updates.
- The A380X page does not write AP2, vertical target, runway-turnoff,
  managed/selected push-pull, light AUTO/detent semantics, or deeper systems.
- The A320neo V2 and A321LR page uses generic standard controls. AP master does
  not mean AP1 or AP2, and FLC, LOC-only, Airbus managed push/pull, spoilers,
  runway-turnoff writes, and deeper systems remain unavailable.
- The 737 MAX 8 page does not provide CMD A/B, VNAV, autobrake, spoilers,
  runway-turnoff writes, engines, or deeper systems.
- Legacy Recent Flights entries without recording-start metadata currently
  appear as Recorded at the Unix epoch instead of displaying their saved-file
  time.
- Fenix vertical speed and FPA editing remain read only.
- The A330 does not yet expose separate AP1 and AP2 controls, managed mode push
  and pull, EXPED, or deeper aircraft systems.
- Current-rules rescoring updates completed landing analysis without changing
  the recorded flight.
- Microsoft Flight Simulator 2024 is the supported simulator. MSFS 2020 and
  X-Plane are not currently supported.

See `README.md`, `SAFETY-NOTICE.md`, `LICENSE.md`, and
`THIRD_PARTY_NOTICES.md` for requirements, safety information, licence terms,
and third-party notices.
