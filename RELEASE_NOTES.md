# Flight Fabric 0.9.4 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.9.4/Flight.Fabric.Setup.0.9.4.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Open the downloaded installer, follow the setup steps, then launch Flight
Fabric with MSFS 2024 running.

Flight Fabric is experimental alpha software for consumer flight simulators.
It is not certified, approved, or intended for real-world aviation. Do not rely
on it for real-world decisions.

## What's new

- **Clearer landing wind graphics:** both arrows show airflow, while the
  bearing clearly states where the wind comes from, measured against true north.
- **Correct aircraft placeholders:** Beluga aircraft and unnamed timeline
  flights use the aircraft/question-mark graphic when suitable artwork is absent.
- **Aircraft support tools for developers:** inspect existing mappings,
  compare revisions, and capture selected readings during manual testing.

<details>
<summary><strong>Full release notes</strong></summary>

## Landing wind graphics

The compass arrow now follows the same airflow convention as the runway
graphic. A wind labelled **FROM 305°T** comes from the northwest; the compass
arrow points toward the southeast. Both graphics say **Arrow shows airflow**.

The runway view rotates that airflow relative to the runway's true heading,
so the arrow agrees with the headwind, tailwind and crosswind geometry.
The bearing continues to describe the wind's source; it is not reversed.
Calm wind and unavailable wind speed do not display a directional arrow.

## Aircraft artwork

Beluga and BelugaXL aircraft now use the neutral aircraft/question-mark graphic
instead of inheriting an ordinary Airbus image from a broader family match.
Loaded timeline flights without an aircraft name also retain the placeholder
in the inspector and mobile replay header.

## Developer tools

The source repository includes a local aircraft support workbench for
developers and technical testers. It can report implemented mappings, compare
revisions to identify controls worth retesting, and record selected readings
during an explicitly started manual test. No LLM connection or API key is needed.

Capture is bounded and read-only. Reports and captures do not upload
automatically, add new cockpit controls, or establish live aircraft verification.
The workbench keeps its settings separate from normal Flight Fabric settings
and checks aircraft identity, reading freshness and connection state.

The website also has clearer MSFS 2024 wording, blog links, and a permanent
Windows download address shared with the getting-started material.

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

The installer is `Flight.Fabric.Setup.0.9.4.exe`. The **Source code** archives
in GitHub's Assets section are for developers; you only need the installer to
use Flight Fabric.

The current alpha is unsigned, so Windows may show an **Unknown publisher**
warning. Use the official installer linked at the top of this page.

If you want to verify your download, GitHub shows its SHA-256 checksum beside
the installer in **Assets**. This is an optional file-integrity check, not an
installation step.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Safety information](https://github.com/yenbuilds/flight-fabric/blob/v0.9.4/SAFETY-NOTICE.md) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.9.4/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.9.4/THIRD_PARTY_NOTICES.md)
