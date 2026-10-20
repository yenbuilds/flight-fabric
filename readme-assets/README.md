# README screenshots and tour

The `*-20261020.png` images show the 0.12.7 interface captured on 20 October
2026 with offline sample data, rendered through the real Vue app shell and
components. They are source
previews, not captures from the published installer or evidence of MSFS acceptance.
The root README labels the sample data and capture date.

The four full 1440 × 900 captures show Flight overview, Aircraft presets, Logbook with
3D timeline replay, and the recorded landing debrief. The debrief uses the same
controller as the app runtime with representative wind/attitude measurements
added to the workbench fixture's recorded landing. Voice is shown ready using
fixture state; no microphone, simulator or account is contacted. Online map tiles
are disabled, and the replay uses its built-in 3D flight-path view.

Six focused desktop crops form the README gallery, adding Voice setup and the
PMDG 737 Mode Control Panel. Static Windows-style title bars frame these crops.
The same command emits current desktop, voice-test, setup, toolbar and mobile
images to `site/flightfabric/assets/app-<date>/`. Mobile screenshots use a slim
smartphone frame. Framing and cropping preserve the captured UI pixels; they
are publication artwork and do not change the application window or controls.
The tablet plan remains an unframed browser view. Voice-test results and toolbar
installation states are simulated fixture data, with no actual microphone,
installation or aircraft command performed.

Regenerate after installing the project dependencies and FFmpeg:

```powershell
npm.cmd run build:backend:runtime
npm.cmd run frontend:build
$captureDate = Get-Date -Format yyyyMMdd
node scripts/dev/capture-readme-assets.js $captureDate
```

The argument is a `YYYYMMDD` capture date. Update the root README's
image links and capture date. The capture command reuses the existing workbench
browser fixture in capture-only mode; ordinary browser tests still run by default.
Its temporary frames and capture report are under `.tmp/readme-assets-<date>/`.

`flight-fabric-tour.gif` is rebuilt from those same four images, in the same order,
at 1080 px wide. Each frame remains for four seconds; the 16-second tour loops.
FFmpeg generates a shared palette and applies ordered dithering to keep it small.
The icon and Windows SmartScreen installation screenshot have separate purposes
and are not part of the app tour.

Before using new captures, inspect every PNG and every decoded GIF frame. Check
legible text, complete images, useful framing and the absence of cursor labels or
automation overlays. Captures come from a hidden Electron content surface, so no
desktop cursor is included. Dismiss the ordinary first-command suggestion through
its own dismissal action before capture; no product UI is painted over or retouched.

Historical verification from 29 September 2026: all four PNGs and decoded GIF frames were inspected.
The final capture reported no missing images, horizontal overflow, renderer errors
or first-command prompts (`check-qNVM4o`). The normal workbench checks passed
56 populated views across eight desktop/tablet/phone layouts (`check-bAtEK3`);
repository link hygiene (`check-gjvyA4`) and public-export checks (`check-cRjX87`)
also passed. Full logs are in ignored `.tmp/check-logs/`. The GIF is 691,314 bytes,
1080 × 676 px, with four four-second frames and an infinite loop.

Current verification on 20 October 2026: capture-only rendering passed with no
missing images, overflow, renderer errors or first-command prompts
(`check-35FRki`). All published PNGs and four decoded GIF frames were inspected.
The new tour is 686,714 bytes at 1080 × 676 px, with the same four-frame timing.
Website checks cover the homepage and both product guides at 1440, 820, 390 and
320 px, image decoding, local anchors and gallery open/close behavior.
Full evidence is in `.tmp/readme-assets-20261020/`, `.tmp/media-refresh/` and
`.tmp/check-logs/`. The normal workbench coverage above is historical; this
change affects publication artwork and capture tooling, not product behavior.

## Other assets

`flightfabric-logo.svg` is the canonical logo source. Regenerate the application
icons through `npm run icons:generate`; use `npm run icons:check` to check them.
See [logo ownership](../docs/FRONTEND-TAILWIND-THEMING.md#product-logo).
`flight-fabric-icon.png` is used by the root README. The dated Windows
SmartScreen image documents the installer flow; it is separate from the app
tour. Older screenshots in this folder are historical assets, not a claim about
the current interface.
