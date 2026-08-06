# Theme assets

These CSS files keep older widget links and user overrides working. The main
dashboard now uses one dark theme and no longer has a theme picker.

## Storage

Bundled defaults:

```text
frontend/themes/
  theme-default.css
  theme-web3-dark.css
```

User overrides:

```text
%APPDATA%/Flight Fabric/Themes/
  theme-default.css
  theme-web3-dark.css
```

macOS uses `~/Library/Application Support/Flight Fabric/Themes/`.
Linux uses `${XDG_CONFIG_HOME:-~/.config}/Flight Fabric/Themes/`.

Flight Fabric looks for `/user-assets/themes/<filename>` first. If a valid user
file is not present, it uses the bundled file with the same name.

## Available assets

| Theme | Description | Best for |
|-------|-------------|----------|
| **Default** | Dark blue and understated | General use |
| **Web3 Dark** | Rounded obsidian glass with crisp blue accents | Night flying, modern HUD feel |

## Usage

### Dashboard and widgets

The dashboard and streaming widgets map older saved theme names to the current
dark theme. To override an asset, copy it to the application data themes folder
and keep the same filename.

### Other HUD consumers

Other HUD and overlay code can reference `themes/theme-*.css` directly.

### Loading a theme file in code

```javascript
// Remove any existing theme
document.querySelectorAll('link[data-theme]').forEach(el => el.remove());

// Add new theme
const link = document.createElement('link');
link.rel = 'stylesheet';
link.href = 'themes/theme-web3-dark.css';
link.dataset.theme = 'web3-dark';
document.head.appendChild(link);
```

## Creating custom overrides

Copy a bundled theme into the application data themes folder and change its CSS
variables:

```css
:root {
  /* Core colors */
  --hud-bg: #your-background;
  --hud-surface: #your-surface;
  --hud-text: #your-text;
  --hud-accent: #your-accent;
  --hud-success: #your-green;
  --hud-warn: #your-yellow;
  --hud-danger: #your-red;
  
  /* Panel styling */
  --hud-panel-bg: rgba(...);
  --hud-panel-border: rgba(...);
  
  /* Sizing */
  --hud-radius: 10px;
  --hud-blur: 6px;
}
```

## Notes

- Themes override shared variables through CSS specificity.
- The Web3 dark theme uses `backdrop-filter`; unsupported browsers fall back to
  solid surfaces.
- Widgets map older saved theme names to the current dashboard theme.
