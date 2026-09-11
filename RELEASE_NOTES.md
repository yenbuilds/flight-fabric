# Flight Fabric 0.9.3 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.9.3/Flight.Fabric.Setup.0.9.3.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Open the downloaded installer, follow the setup steps, then launch Flight
Fabric with MSFS 2024 running.

Flight Fabric is experimental alpha software for consumer flight simulators.
It is not certified, approved, or intended for real-world aviation. Do not rely
on it for real-world decisions.

## What's new

- **More aircraft controls and voice commands**, with searchable controls,
  lighting adjustments, and expanded radio and approach support.
- **More consistent approach scoring**, with clearer feedback and the option
  to rescore saved flights.
- **Easier flight reviews**, with saved timeline filters and replay fixes.

<details>
<summary><strong>Full release notes</strong></summary>

## Aircraft controls and voice

- A searchable **All aircraft controls** section exposes additional supported
  controls across 19 aircraft profiles, with value editors and voice examples.
  PMDG 737/777, Fenix A32X and FlyByWire aircraft gain broader access to their
  existing systems; the available commands still depend on the exact aircraft.
- Main autopilot targets have more consistent UI and voice support, including
  speed/Mach, heading, altitude and vertical speed where supported. Controls
  respect aircraft modes, current telemetry and valid input ranges.
- PMDG APU start requests use the START position. Start feedback distinguishes
  an accepted request from an APU that has actually become available. Complete
  spoken letter names such as "AY PEE YOU" are handled more consistently.
- Cockpit lighting and flight-display brightness can be set separately on
  PMDG 737/777, Fenix A32X, FBW A32NX/A380X and Headwind A330. For example, set
  cockpit lighting to 50%, then display brightness to 80%. The display group
  includes primary, navigation and engine/system screens, but excludes
  CDU/MCDU units, tablets and standby instruments.
- Landing, taxi and runway-turnoff lights have individual commands where
  mapped. **Set takeoff lights** retains its full lighting-preset behavior.
- Radio, transponder, minimums and approach controls have expanded UI and
  voice coverage. QNH and STD are available on FBW A32NX and Fenix A32X;
  FBW A380X also gains STD. PMDG 737/777 and iniBuilds A350 QNH/STD remain
  unavailable pending a reliable mode and readback contract.

## Approach scoring and flight review

The new approach assessment uses graded, time-based quality scores. Transport
aircraft normally share a 1,000 ft height gate; distance and changing weather
do not silently move that gate. Deviations below 500 ft carry more weight,
valid ILS guidance takes precedence over path-rate estimates, and related
vertical deviations are grouped to avoid duplicate deductions.

Amber cautions, red violations and neutral recovery events make the timeline
easier to interpret. Configuration failures and severe deviations still affect
the final verdict. Missing telemetry, pauses and insufficient approach coverage
are disclosed rather than treated as good flying.

Existing recorded scores remain unchanged until you explicitly apply new
analysis through **Review scoring**. Rescore results propagate to the timeline,
logbook and landing debrief, including flights without runway geometry.

Timeline Inspector now has filters for configuration changes such as flaps,
automation and flight guidance. All start enabled, and your choices are saved
locally. Filtering does not alter the recording, score or map-layer settings.

Aircraft without a suitable picture now show a neutral aircraft/question-mark
symbol, with separate labels for an unknown aircraft and an unavailable image.

## Reliability and maintenance

- Improved touch-and-go and go-around replay boundaries, sparse throttle
  observations, and retention of completed landing scores.
- Missing landing scores and rollout measurements remain unavailable; actual
  zero values retain their meaning.
- Improved aircraft-control freshness, failed-send feedback and reconnect
  handling, and streamlined PMDG setup.
- Updated build dependencies to address the js-yaml security advisory and
  expanded automated regression coverage.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

New aircraft mappings have not all completed live simulator testing. Automated
tests verify routing and guards, not actual cockpit response or recognition
with every microphone. PMDG controls require the matching installed aircraft
and working SDK data. Unsupported commands remain unavailable; this release
does not provide universal command parity across every aircraft.

Generic SimConnect controls remain best-effort compatibility controls. Complex
add-ons can ignore standard events or keep authoritative state elsewhere.
Known generic-page edge cases include the V/S adjustment-button range,
unknown parking-brake presentation and NAV frequency drafts during telemetry
updates. The iniBuilds A330 integration remains readback-only.

Approach scores are aviation-informed game rules. Gate IAS is an estimate,
not the aircraft's selected VAPP/Vref, and unusual approaches can fall outside
the scoring assumptions.

Voice recognition works only in the Windows desktop app. Push to talk is off
by default and accepts only commands advertised for the active aircraft.

Online maps use OpenStreetMap's community tile service. Flight Fabric does not
prefetch or provide offline tiles. Online map traffic can be disabled in
Settings. MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

The installer is `Flight.Fabric.Setup.0.9.3.exe`. The **Source code** archives
in GitHub's Assets section are for developers; you only need the installer to
use Flight Fabric.

The current alpha is unsigned, so Windows may show an **Unknown publisher**
warning. Use the official installer linked at the top of this page.

If you want to verify your download, GitHub shows its SHA-256 checksum beside
the installer in **Assets**. This is an optional file-integrity check, not an
installation step.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Safety information](https://github.com/yenbuilds/flight-fabric/blob/v0.9.3/SAFETY-NOTICE.md) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.9.3/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.9.3/THIRD_PARTY_NOTICES.md)
