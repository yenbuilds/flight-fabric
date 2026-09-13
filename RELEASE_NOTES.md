# Flight Fabric 0.9.6 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.9.6/Flight.Fabric.Setup.0.9.6.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Close Flight Fabric, open the downloaded installer and follow the setup steps.
Then launch Flight Fabric with MSFS 2024 running.

## What's new

- **Fewer false landing warnings:** uncertain runway alignment is shown as
  unverified, and excursion warnings need sustained off-runway evidence.
- **Fairer touchdown and airspeed scoring:** touchdowns within 3,000 ft of the
  threshold receive full touchdown-zone credit when before the runway end.
  Airspeed assessment uses a reliable selected speed when available.
- **Clearer approach charts:** the default view focuses on the stability gate
  and final approach. Earlier turns remain available as unscored context.
- **Brief stall-warning pulses filtered:** a momentary simulator signal no
  longer creates a stall event in the flight timeline.

For an older flight, open its timeline, choose **Review scoring**, review the
updated results, then select **Save all current scoring** to keep them.

<details>
<summary><strong>Full release notes</strong></summary>

### Landing warnings and scoring

For live MSFS flights, Flight Fabric tries the MSFS Facilities API first for
runway geometry. The OurAirports database is a fallback when suitable simulator
geometry is unavailable.

In 0.9.6, alignment and runway-edge measurements based on that database fallback
are marked unverified and excluded from scoring. Simulator geometry remains
eligible for scoring when the measurements are reliable; conflicting on-runway
readings also leave the affected measurements unverified. A runway excursion
warning requires a sustained transition from runway contact to an off-runway
unpaved or water surface at high speed.

Touchdowns from the threshold through 3,000 ft receive full touchdown-zone
credit, provided they occur before the runway end. Weather no longer shortens
that scoring zone, and unavailable weather is left unknown. Short landings and
touchdowns beyond the runway end retain their warnings.

Approach airspeed is assessed against the selected speed recorded at the
stability gate when reliable target data and active autothrottle are available.
Without that evidence, the target-speed criterion is left unscored. A speed
sample at the gate is no longer assumed to be the intended approach speed.

Stall events now require a continuous airborne warning for at least one second.
Reviewing an older flight with current scoring also removes complete warning
pulses shorter than one second.

### Approach charts

Side and ground-track views start with a little context above the stability
gate. Expand **Show full approach context** to see the earlier descent and
turn-in. Earlier manoeuvres are shown as context, and warning colours follow
the events assessed within the scoring window.

The gate is labelled where scoring starts. The dashed 3° line is a reference
path. Recordings with too little final-approach data show the available context
with an explanation instead of losing the chart.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

The selected-speed reference is an aircraft target, not a verified VAPP or
Vref. Unavailable target, runway or approach-guidance data remains unscored
where required; a high score does not imply that every criterion was measured.

Aircraft mappings have not all completed live simulator testing. PMDG controls
require the matching installed aircraft and working SDK data. Unsupported
commands remain unavailable. Generic SimConnect controls remain best-effort
compatibility controls, and the iniBuilds A330 integration is readback-only.

Blank PMDG IAS/Mach and V/S/FPA windows remain unavailable until the aircraft
provides the corresponding target readback. Setting a target does not open a
cockpit window or engage an autopilot mode.

Voice recognition works only in the Windows desktop app. Push to talk is off
by default and accepts only commands advertised for the active aircraft.

Online maps use OpenStreetMap's community tile service. Flight Fabric does not
prefetch or provide offline tiles. Online map traffic can be disabled in
Settings. MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

The installer is `Flight.Fabric.Setup.0.9.6.exe`. The **Source code** archives
in GitHub's Assets section are for developers; you only need the installer to
use Flight Fabric.

The current alpha is unsigned, so Windows may show an **Unknown publisher**
warning. Use the official installer linked at the top of this page.

If you want to verify your download, GitHub shows its SHA-256 checksum beside
the installer in **Assets**. This is an optional file-integrity check.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.9.6/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.9.6/THIRD_PARTY_NOTICES.md)
