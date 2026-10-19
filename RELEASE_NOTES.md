# FlightFabric 0.12.6 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.12.6/FlightFabric.Setup.0.12.6.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight before updating. You can check for supported desktop updates
in **Settings > About**, or choose **Quit FlightFabric** from the system tray
and run the installer above. Your settings and recordings stay in their current
locations. Users on 0.12.1 or earlier need the manual installer.

To update the MSFS toolbar, close MSFS, open **Settings > MSFS 2024 toolbar panel**,
choose **Update** or **Reinstall**, then restart the simulator.

## What's new

- **Logbook totals:** deleting a recording also refreshes scored flight history
  and all-time statistics across your connected windows.
- **Clearer flight-mode feedback:** heading and approach requests that cannot be
  confirmed ask you to check the flight mode annunciator; approach voice feedback
  describes the selection without claiming capture.
- **Voice setup:** first-time setup recommends push-to-talk voice control while
  preserving existing preferences and leaving microphone access until voice is used.
- **Debrief cleanup:** remove the convective-risk assessment and its CSV fields.
  Existing recordings and saved landing results remain readable.

<details>
<summary><strong>Full release notes</strong></summary>

### Logbook deletion

After a recording is successfully deleted, the Logbook refreshes its scored
history and all-time totals in connected windows with control permission.
You no longer need to reopen or manually refresh the Logbook to update those totals.

### Heading and approach feedback

Heading select, heading hold and approach requests now distinguish a command
that was sent without confirmation from one that could not be sent. If confirmation
is lost, the app and spoken feedback ask you to check the flight mode annunciator
before retrying. Successful approach voice feedback says the approach was selected;
capture and active modes still need to be checked in the cockpit.

### Voice setup

First-time setup recommends enabling push-to-talk voice control. Existing saved
choices stay intact, and completing setup does not access your microphone. You can
change the preference later in Settings or replay the introduction from
**Settings > General > Introduction**.

### Simpler flight review

Convective-risk assessment has been removed from flight review and new CSV
recordings. New CSVs omit its dedicated fields; all remaining fields keep their
names, units and meanings. Tools that read CSV columns by position need to use
the recording's header instead.

Existing recordings remain unchanged and readable, and saved landing results
are preserved. Landing, approach-stability, takeoff and flight-upset assessments
remain available. Logbook playback remains available after retirement of the
experimental in-simulator replay prototype.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

Experimental Autotaxi can stop after a control-write failure and can require
manual parking-brake handover at the holding point.

Voice recognition results depend on your microphone, accent and background
noise. Controller compatibility varies; reconnecting a device may require
selecting its button again.

Aircraft and scenery combinations have not all been verified. The iniBuilds A380
integration is partial. Aircraft controls require the appropriate setup and
fresh data.

The A350 surface controls have ground checks on the -1000; the -900,
airborne operation and actual automatic braking remain unverified. MD-11
surface controls have limited ground checks on the PW4462, while the added
flight-guidance buttons still need live verification. These additions do not
establish complete aircraft or variant support. Reported PMDG heading/approach
commands that do not respond are still under investigation.

Desktop 3D maps require compatible graphics support and online imagery services.
Phone and tablet control requires pairing and approval on the simulator PC.
MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

Download `FlightFabric.Setup.0.12.6.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.12.6.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.12.6/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.12.6/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
