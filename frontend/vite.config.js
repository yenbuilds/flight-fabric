import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function keepTailwindBeforeBundledCss() {
  return {
    name: 'flight-fabric-tailwind-cascade-order',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const tailwindLinkPattern = /[ \t]*<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["'][^"']*tailwind\.css["'])[^>]*>\r?\n?/g;
        const matches = [...html.matchAll(tailwindLinkPattern)];
        if (matches.length === 0) return html;

        const tailwindLink = matches[0][0].trimEnd();
        const withoutTailwind = html.replace(tailwindLinkPattern, '');
        const firstStylesheetMatch = /[ \t]*<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*>\r?\n?/.exec(withoutTailwind);
        if (!firstStylesheetMatch) return html;

        return withoutTailwind.slice(0, firstStylesheetMatch.index) +
          tailwindLink +
          '\n' +
          withoutTailwind.slice(firstStylesheetMatch.index);
      },
    },
  };
}

/**
 * Vite configuration for Flight Fabric frontend.
 *
 * Architecture notes:
 * - Dev server: `npm run dev` (from frontend/) or `npm run frontend:dev` from the root starts
 *   a hot-reloading server at http://127.0.0.1:5173. Electron dev mode continues to use its
 *   own static file server by default; use the Vite server for rapid UI iteration without
 *   needing the full Electron wrapper.
 *
 * - Production build:
 *   `npm run frontend:build` now runs Vite and then copies the remaining
 *   compatibility assets (plain-script `flight-phases.js` and `themes/`)
 *   into `frontend-dist/`. Electron and the backend HTTP server
 *   both consume that bundled output.
 *
 * Migration path (IIFE -> ES modules):
 * - All current <script src="..."> tags are NON-module scripts. Vite warns about them but
 *   leaves them unchanged in the output HTML. No bundling happens for these files until they
 *   are converted.
 * - To migrate a file: (1) remove its IIFE wrapper, (2) add export/import statements,
 *   (3) change the HTML tag from <script src="..."> to <script type="module" src="...">.
 *   New sub-modules in src/ can be imported from the converted file immediately.
 * - The main app entrypoints now use thin ES module bootstraps that delegate to runtimes under
 *   src/. Remaining plain <script> holdouts are intentional compatibility assets such as
 *   flight-phases.js.
 * - flight-phases.js stays as a UMD file permanently - backend/lifecycle/phases.js
 *   require()s it. Load it as a plain <script> and access window.FlightPhases in non-module
 *   contexts; create a thin re-export in src/shared/ for ES module consumers.
 *
 * External libraries:
 * - Leaflet: bundled from the frontend npm dependency.
 * - Tailwind CSS: compiled separately via the tailwindcss CLI step in build-electron.js.
 *   The pre-compiled tailwind.css is treated as a static passthrough asset here.
 */
export default defineConfig({
  root: __dirname,
  plugins: [vue(), keepTailwindBeforeBundledCss()],

  // Static assets served by the dev server. themes/ are always included.
  // The root itself is also the public dir so index.html and compact widget HTMLs resolve correctly.
  publicDir: false,

  server: {
    host: '127.0.0.1',
    port: 5173,
    // Proxy API requests to the local backend so the Vite dev server can be used
    // without running through Electron. Adjust ports if your local backend differs.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8100',
        changeOrigin: false,
      },
    },
  },

  build: {
    outDir: resolve(__dirname, '../frontend-dist'),
    chunkSizeWarningLimit: 650,
    // The outer frontend build wrapper clears the output directory before
    // invoking Vite, then restores compatibility assets afterward.
    emptyOutDir: false,

    rollupOptions: {
      // Multi-page: each HTML file is a separate entry point.
      // As files are migrated to ES modules Vite will bundle their module graphs;
      // non-module <script src> references remain as static file references.
      input: {
        main:               resolve(__dirname, 'index.html'),
        'widgets-compact/widget': resolve(__dirname, 'widgets-compact/widget.html'),
        'widgets-compact/widget-autopilot': resolve(__dirname, 'widgets-compact/widget-autopilot.html'),
        'widgets-compact/widget-bottom': resolve(__dirname, 'widgets-compact/widget-bottom.html'),
        'widgets-compact/widget-environment': resolve(__dirname, 'widgets-compact/widget-environment.html'),
        'widgets-compact/widget-history': resolve(__dirname, 'widgets-compact/widget-history.html'),
        'widgets-compact/widget-top': resolve(__dirname, 'widgets-compact/widget-top.html'),
      },

      output: {
        // Preserve readable filenames without content hashes during the IIFE-to-ESM
        // migration. Once the migration is complete, hashing can be re-enabled for
        // cache-busting in browser deployments.
        entryFileNames: '[name].js',
        chunkFileNames: 'src/chunks/[name].js',
        assetFileNames: (assetInfo) => {
          const name = assetInfo.names?.[0] ?? '';
          if (name.endsWith('.css')) return '[name].[ext]';
          return 'assets/[name].[ext]';
        },
      },
    },
  },
});
