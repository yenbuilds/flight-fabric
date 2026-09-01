# Flight Fabric 0.8.2

Flight Fabric 0.8.2 fixes stale control input on the Generic Aircraft, PMDG 737,
and PMDG 777 pages.

## Fixed

On the Generic Aircraft page, the autopilot target editor now closes when the
aircraft changes or controls disconnect. A target entered before a disconnect
cannot become active after reconnecting.

The PMDG 737 and 777 pages now clear typed MCP, radio, direct entry, and
lighting values when the aircraft profile or data source changes. Their panels
also start fresh when a different aircraft profile revision loads.

## Download

Download `Flight.Fabric.Setup.0.8.2.exe` from GitHub Releases. GitHub displays
the installer's immutable SHA-256 digest beside the asset. The portable
executable remains a local verification artifact and is not published.

Flight Fabric is unsigned experimental alpha software for consumer flight
simulators. It is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world decisions. Windows may show an **Unknown
publisher** warning.

## Known limitations

The Flight Guidance lane is currently limited to the PMDG 777-300ER,
777-200ER, 777-200LR, and 777F profiles. It appears only when a recording has
fresh PMDG SDK data. Unavailable fields are omitted rather than inferred.

Voice recognition works only in the Windows desktop app. It requires push to
talk, is off by default, and accepts only commands advertised for the active
aircraft. It does not listen continuously.

Fenix A32X FCU and virtual throttle write routes have not completed live
testing. Do not move the same physical FCU rotary while a typed target is
pending. Fenix FCU writes require a compatible MobiFlight Event Module
connection.

PMDG 737 and 777 controls require the matching installed aircraft and working
SDK data. Controls without verified support remain unavailable.

Online maps use OpenStreetMap's community tile service. Flight Fabric does not
prefetch or provide offline tiles. Online map traffic can be disabled in
Settings.

Microsoft Flight Simulator 2024 is the supported simulator. MSFS 2020 and
X-Plane are not currently supported.

See `README.md`, `SAFETY-NOTICE.md`, `LICENSE.md`, and
`THIRD_PARTY_NOTICES.md` for requirements, safety information, licence terms,
and third-party notices.
