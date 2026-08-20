# Flight Fabric 0.5.0

Flight Fabric 0.5.0 restores guarded PMDG aircraft integrations and makes
recording, approach assessment, and flight history more reliable across real
simulator sessions.

## Added

- PMDG 737 and 777 family profiles, aircraft-specific panels, and guarded SDK
  controls are available again. SDK readback stays disabled until you accept
  the matching aircraft's installed EULA in Flight Fabric.

## Fixed

- Pausing a connected simulator no longer re-arms automatic recording after a
  manual stop. Genuine disconnects, simulator stops, aircraft changes, and
  parked-engines-off resets still re-arm it.
- Flight phases recover cleanly through sparse rollouts and consecutive flights
  in the same aircraft, allowing parked-engines-off recording finalisation.
- Approach stability leaves unavailable gear and flap data unscored, preserves
  authoritative profile flap data, and uses actual sampling cadence for speed
  and thrust trends.
- Recent Flights and Logbook history keep flight and landing data consistently
  linked, retain unknown fuel burn as unknown, and rebuild outdated derived
  history data from the authoritative recordings.

## Download

- `Flight.Fabric.Setup.0.5.0.exe`
- `SHA256SUMS.txt`

Only the installer and `SHA256SUMS.txt` are release downloads. The portable
executable remains a local build and verification artifact and is not
published.

Flight Fabric is unsigned experimental alpha software for consumer flight
simulators. It is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world decisions. Windows may show an **Unknown
publisher** warning.

## Known limitations

- The FlyByWire A32NX and A380X write routes remain marked untested pending
  live validation in current aircraft releases and require a compatible
  MobiFlight Event Module connection.
- FlyByWire virtual throttles expose only the four forward detents. Invalid or
  missing calibration, reverse thrust, sliders, arbitrary axis positions, and
  split-lever targets fail closed or remain unavailable.
- The phone link is private and works only on the same trusted network. Its
  aircraft-control pairing expires when the Flight Fabric backend restarts,
  and aircraft commands still require the LAN control setting.
- Fenix A32X FCU and virtual-throttle write routes remain marked untested. Do
  not move the same physical FCU rotary while a typed target is pending.
- PMDG 737 and 777 controls remain guarded but require live validation for the
  installed aircraft version; unavailable, maintenance, emergency, door, and
  momentary controls stay excluded.
- Legacy Recent Flights entries without recording-start metadata currently
  appear as Recorded at the Unix epoch instead of displaying their saved-file
  time.
- Microsoft Flight Simulator 2024 is the supported simulator. MSFS 2020 and
  X-Plane are not currently supported.

See `README.md`, `SAFETY-NOTICE.md`, `LICENSE.md`, and
`THIRD_PARTY_NOTICES.md` for requirements, safety information, licence terms,
and third-party notices.
