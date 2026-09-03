# Flight Fabric 0.9.1

Flight Fabric 0.9.1 hardens aircraft-profile selection and the native
push-to-talk helper lifecycle, removes unused code and dependencies, and
refreshes project documentation.

## Fixed

A manually selected bundled aircraft profile now remains active across
simulator aircraft-change events. Automatic matching also treats a generic
MSFS Community-folder root and arbitrary livery folder names as non-identity
evidence, so an ambiguous aircraft falls back safely instead of activating an
incorrect product-specific integration.

The native Windows push-to-talk helper is tied more tightly to the desktop app
lifecycle. It exits if its parent output pipe becomes blocked or disconnected,
and a registration still starting during shutdown cannot reactivate the global
keyboard hook.

Unused code and dependencies were removed, a Knip dead-code audit was added,
and mobile, release, X-Plane, and documentation-index guidance was refreshed.

## Download

Download `Flight.Fabric.Setup.0.9.1.exe` from GitHub Releases. GitHub displays
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

iniBuilds A350-900 and A350-1000 controls have not completed live testing.
Auto-resetting AP1/AP2, A/THR, LOC, APPR, and FCU push/pull variables remain
unavailable because the published interface does not provide stable independent
confirmation for those commands.

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
