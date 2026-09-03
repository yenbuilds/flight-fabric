# Flight Fabric 0.9.0

Flight Fabric 0.9.0 adds dedicated iniBuilds A350 controls and improves offline
voice recognition and push-to-talk reliability across supported aircraft.

## Added

The iniBuilds A350-900 and A350-1000 now have a dedicated aircraft page and a
shared guarded adapter. The integration covers bounded speed, heading,
altitude, and vertical-speed targets; selected persistent cockpit systems;
conservative surface controls; exterior lights; and an ordered takeoff-light
preset. Its 15 canonical voice commands use the same backend routes as the UI.

All A350 write actions remain marked untested until they are validated live
against current installed A350-900 and A350-1000 builds. Unsupported or stale
routes fail closed.

## Fixed

Voice commands now handle common aviation number phrasing more reliably while
keeping corrections scoped to commands where they are safe. Examples include
`set heading two eight zero`, altitude shorthand such as `set altitude one five
zero`, and explicit `engage autopilot one` or `engage autopilot two` channel
selection. Explicit feet values and normal cardinal numbers remain literal.

PMDG 777 altitude targets are available to voice, incomplete autopilot commands
ask for a channel, and `set takeoff lights` is accepted alongside `set lights
for takeoff` on every aircraft whose active catalogue supports that preset.

Releasing push to talk now keeps recording for a fixed 250 ms tail, flushes the
audio worklet, and queues every captured frame before final decoder processing.
The press and release cues are also louder and use a more audible waveform.

Landing-distance analysis now treats outside-air temperature without an
explicit precipitation observation as insufficient runway-weather evidence and
fails safe to a wet surface.

## Download

Download `Flight.Fabric.Setup.0.9.0.exe` from GitHub Releases. GitHub displays
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
