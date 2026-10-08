# FlightFabric 0.12.2 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.12.2/FlightFabric.Setup.0.12.2.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

If you are using 0.12.1 or earlier, install this release once using the download
above. Finish your flight, choose **Quit FlightFabric** from the system tray, then
run the installer. Your settings and recordings stay in their current locations.
Future supported desktop updates can be downloaded from **Settings > About**,
then installed with **Restart and update** when you are ready.

To update the MSFS toolbar, close MSFS, open **Settings > MSFS 2024 toolbar panel**,
choose **Update** or **Reinstall**, then restart the simulator.

## What's new

- **In-app updates:** download future desktop updates from Settings > About and
  install them with Restart and update after finishing your simulator session.
- **Easier Windows setup:** include the required Microsoft runtime so a fresh PC
  can start FlightFabric without separately finding and installing it.
- **Voice recovery:** improve microphone cleanup after push-to-talk and voice
  tests, helping the next recognition attempt remain available.
- **Clearer voice guidance:** show relevant restart advice in the sidebar when
  offline voice reports a startup failure.

<details>
<summary><strong>Full release notes</strong></summary>

### Updates when you are ready

FlightFabric shows download progress and asks before restarting to install an
update. Downloading an update does not restart the app. Finish your simulator
session and save or discard pending Settings changes before choosing to install.

You can cancel or retry downloads. If an update cannot proceed, FlightFabric
explains the problem and provides a link to the installer for manual repair.

The first release with in-app updates needs the manual installation described
above. Phone browsers and the MSFS toolbar keep their existing update procedures.

### Startup on fresh Windows installations

Setup includes the Microsoft Visual C++ runtime used by FlightFabric's connection
and voice components. It checks the installed runtime before changing app files
and tells you if setup cannot continue or Windows needs a restart.

### Microphone cleanup and restart guidance

Microphone cleanup is more resilient after releasing or cancelling push-to-talk
and after voice tests, helping subsequent recognition attempts start normally.

When offline voice reports a startup failure, the sidebar explains how to fully
quit and reopen FlightFabric. The advice disappears after recovery. Closing the
main window only hides the app; choose **Quit FlightFabric** in the system tray
when a full restart is needed.

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

Desktop 3D maps require compatible graphics support and online imagery services.
Phone and tablet control requires pairing and approval on the simulator PC.
MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

Download `FlightFabric.Setup.0.12.2.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.12.2.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.12.2/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.12.2/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
