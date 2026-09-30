# README screenshots and tour

The `*-20260929.png` images show the current source interface with offline sample
data, rendered through the real Vue app shell and components. They are development
previews, not captures from the published installer or evidence of MSFS acceptance.
The root README labels both the images and tour accordingly.

The four 1440 × 900 captures show Flight overview, Aircraft presets, Logbook with
3D timeline replay, and the recorded landing debrief. The debrief uses the same
controller as the app runtime with representative wind/attitude measurements
added to the workbench fixture's recorded landing. Voice is shown ready using
fixture state; no microphone, simulator or account is contacted. Online map tiles
are disabled, and the replay uses its built-in 3D flight-path view.

Regenerate after installing the project dependencies and FFmpeg:

```powershell
npm.cmd run build:backend:runtime
npm.cmd run frontend:build
node scripts/dev/capture-readme-assets.js 20260929
```

Use a new `YYYYMMDD` argument for later captures and update the root README's
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
its button before capture; no product UI is painted over or retouched.

29 September verification: all four PNGs and decoded GIF frames were inspected.
The final capture reported no missing images, horizontal overflow, renderer errors
or first-command prompts (`check-qNVM4o`). The normal workbench checks passed
56 populated views across eight desktop/tablet/phone layouts (`check-bAtEK3`);
repository link hygiene (`check-gjvyA4`) and public-export checks (`check-cRjX87`)
also passed. Full logs are in ignored `.tmp/check-logs/`. The GIF is 691,314 bytes,
1080 × 676 px, with four four-second frames and an infinite loop.
