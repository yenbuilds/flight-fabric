# Legacy theme assets

This folder retains two compatibility stylesheets: `theme-default.css` and
`theme-web3-dark.css`. They are served for older links and explicit user-asset
requests. The current dashboard does not load them or expose a theme picker.

The active app theme is Night Shift (`dark`), defined in
`frontend/src/theme/definition.js` and applied by
`frontend/src/theme/runtime.js`. Older saved names normalize to `dark`.
Compact widgets use their own stylesheets and `widget-theme-bootstrap.js`
under `frontend/widgets-compact/`; copying a file here does not switch them
to another theme.

## Compatibility route and overrides

Both the backend and Electron static hosts support explicit requests to
`/user-assets/themes/<filename>`. A safe regular user file is preferred. A
missing override or non-file path falls back to the bundled file of the same
name; paths that escape the owned theme folder are rejected.
Requests to `/themes/<filename>` use the bundled frontend asset route.

User overrides are stored in:

- Windows: `%APPDATA%/Flight Fabric/Themes/`
- macOS: `~/Library/Application Support/Flight Fabric/Themes/`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/Flight Fabric/Themes/`

The on-disk `Flight Fabric` folder spelling is intentional. A consumer must
explicitly load the compatibility URL to use an override; the main dashboard
does not automatically discover or apply these files.

For an existing consumer, copy the matching bundled CSS file and edit the
variables it actually defines, such as `--th-accent` and
`--color-surface-100`. This is compatibility support, not the supported way
to restyle the current app.

## Current visual work

Use the shared semantic tokens and components described in
[Frontend Tailwind Theming](../../docs/FRONTEND-TAILWIND-THEMING.md). Keep the
legacy files and routes until their consumers have an explicit migration.
The existing `test:http-server-assets` command covers override precedence,
fallback and unsafe-file handling.
