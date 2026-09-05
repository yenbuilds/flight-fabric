# Flight Fabric 0.9.2

Flight Fabric 0.9.2 makes the generic Aircraft page more useful and more honest
about simulator control results. It adds independent NAV radio controls and
offline voice commands, enables the full fixed control baseline for Wide-Body
fallback, improves the mobile control experience, and removes unverified
iniBuilds A330 writes.

## Added

Generic Aircraft and Wide-Body Aircraft Base now show independently installed
NAV 1 and NAV 2 receivers. Each receiver displays its active and standby
frequency and supports guarded standby tuning and active/standby swapping.
Fresh receiver telemetry is required before a command can be sent.

The same controls are available to local offline voice. For example, say
`set nav one standby one one zero decimal three`, followed by `swap nav one`.
NAV 2 is addressed separately. A receiver and the word `standby` are required
for tuning, so voice cannot silently tune both receivers or an active frequency.

The generic Aircraft page now has phone-friendly section navigation, clearer
and persistent command feedback, a direct diagnostics link, improved accessible
labels, safer radio edit cancellation, and search alongside section navigation.

## Fixed and hardened

Wide-Body Aircraft Base now exposes the complete fixed standard SimConnect
catalogue used by Generic Aircraft: NAV radios, autopilot, exterior lights,
gear, flaps, parking brake, and spoilers. Aircraft-specific profiles that inherit
from it retain their explicit opt-outs.

Generic control dispatch no longer presents a transport acknowledgement as
proof that an aircraft's cockpit responded. The backend observes asynchronous
SimConnect exceptions and reports successful generic writes as unconfirmed.
The interface and voice feedback tell the pilot to check the simulator.

The native sidecar preserves all five event parameters through the extended
SimConnect event API when available, falls back only for compatible events,
reports packet identifiers and native failures, and does not retry a write that
the simulator may already have accepted.

NAV and exterior-light authorization now uses timestamps from each actual field
callback. Cached readings cannot become fresh through unrelated telemetry, and
readings from a previous aircraft cannot authorize a command.

The iniBuilds A330 adapter is now explicitly readback-only. Its supported
standard telemetry remains available, while undocumented and unverified LVAR
write routes have been removed.

## Download

Download `Flight.Fabric.Setup.0.9.2.exe` from GitHub Releases. GitHub displays
the installer's immutable SHA-256 digest beside the asset. The portable
executable remains a local verification artifact and is not published.

Flight Fabric is unsigned experimental alpha software for consumer flight
simulators. It is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world decisions. Windows may show an **Unknown
publisher** warning.

## Known limitations

Standard SimConnect events are best-effort compatibility controls. Individual
aircraft and complex add-ons may ignore them or keep authoritative state outside
standard readback. Automated tests do not establish that the included 747 or
another aircraft responds correctly in its cockpit.

Five reproduced generic-control issues remain open: V/S adjustment buttons use
an inconsistent +/-6,000 ft/min limit; a failed network send can remain pending;
unknown parking-brake telemetry appears released; unchanged NAV telemetry can
rewrite a partially entered frequency; and the General Aviation, Regional Jet,
and Turboprop base profiles still expose only gear and flap fallback controls.

Voice recognition works only in the Windows desktop app. It requires push to
talk, is off by default, and accepts only commands advertised for the active
aircraft. It does not listen continuously.

Fenix A32X and iniBuilds A350 write routes have not completed live testing.
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
