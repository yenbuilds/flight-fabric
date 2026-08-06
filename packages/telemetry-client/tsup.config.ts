import { defineConfig } from 'tsup';

export default defineConfig([
  // Main library builds (CJS, ESM, DTS)
  {
    entry: {
      index: 'src/index.ts',
      react: 'src/react/index.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    // Externalize React and all its entry points to avoid bundling multiple copies
    external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom'],
  },
  // Browser bundle (IIFE for <script> tags)
  {
    entry: {
      'telemetry-client.browser': 'src/browser.ts',
    },
    format: ['iife'],
    globalName: 'FlightFabric',
    sourcemap: true,
    minify: true,
    // Bundle everything for browser
    noExternal: [/@flight-fabric/],
  },
]);
