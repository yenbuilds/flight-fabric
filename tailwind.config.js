/**
 * Tailwind config for Flight Fabric (V1 strict-local).
 *
 * The V1 Electron build compiles Tailwind at build time into frontend-dist/tailwind.css.
 * This avoids runtime CDN dependencies.
 */

module.exports = {
  darkMode: 'class',
  content: {
    relative: true,
    files: [
      './frontend/*.html',
      './frontend/*.js',
      './frontend/src/**/*.{js,vue,ts}',
    ],
  },
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--background) / <alpha-value>)',
        fg: 'rgb(var(--foreground) / <alpha-value>)',
        card: 'rgb(var(--card) / <alpha-value>)',
        'card-fg': 'rgb(var(--card-foreground) / <alpha-value>)',
        panel: {
          DEFAULT: 'rgb(var(--panel) / <alpha-value>)',
          subtle: 'rgb(var(--panel-subtle) / <alpha-value>)',
          elevated: 'rgb(var(--panel-elevated) / <alpha-value>)',
        },
        muted: 'rgb(var(--muted) / <alpha-value>)',
        'muted-fg': 'rgb(var(--muted-foreground) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        'border-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        primary: 'rgb(var(--primary) / <alpha-value>)',
        'primary-fg': 'rgb(var(--primary-foreground) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)',
          50: 'rgb(var(--color-surface-50) / <alpha-value>)',
          100: 'rgb(var(--color-surface-100) / <alpha-value>)',
          200: 'rgb(var(--color-surface-200) / <alpha-value>)',
          300: 'rgb(var(--color-surface-300) / <alpha-value>)',
        },
        accent:        'rgb(var(--color-accent) / <alpha-value>)',
        'accent-warm': 'rgb(var(--color-accent-warm) / <alpha-value>)',
        danger:        'rgb(var(--color-danger) / <alpha-value>)',
        warning:       'rgb(var(--color-warning) / <alpha-value>)',
        success:       'rgb(var(--color-success) / <alpha-value>)',
        gray: {
          50: 'rgb(var(--gray-50) / <alpha-value>)',
          100: 'rgb(var(--gray-100) / <alpha-value>)',
          200: 'rgb(var(--gray-200) / <alpha-value>)',
          300: 'rgb(var(--gray-300) / <alpha-value>)',
          400: 'rgb(var(--gray-400) / <alpha-value>)',
          500: 'rgb(var(--gray-500) / <alpha-value>)',
          600: 'rgb(var(--gray-600) / <alpha-value>)',
          700: 'rgb(var(--gray-700) / <alpha-value>)',
          800: 'rgb(var(--gray-800) / <alpha-value>)',
          900: 'rgb(var(--gray-900) / <alpha-value>)',
          950: 'rgb(var(--gray-950) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['var(--ff-font-ui)', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['var(--ff-font-mono)', 'SF Mono', 'Consolas', 'monospace'],
        display: ['var(--ff-font-display)', 'Avenir Next', 'Arial Narrow', 'sans-serif'],
        instrument: ['var(--ff-font-mono)', 'SF Mono', 'Consolas', 'monospace'],
      },
      borderRadius: {
        card: 'var(--ff-radius-card)',
        panel: 'var(--ff-radius-panel)',
        pill: 'var(--ff-radius-pill)',
      },
      boxShadow: {
        card: 'var(--ff-shadow-card)',
        soft: 'var(--ff-shadow-soft)',
        accent: 'var(--ff-shadow-accent)',
      },
    },
  },
  plugins: [],
};
