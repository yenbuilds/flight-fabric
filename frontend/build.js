import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(FRONTEND_DIR, '..');
const OUT_DIR = path.join(ROOT, 'frontend-dist');
const VITE_BIN = path.join(FRONTEND_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
const TAILWIND_CONFIG = path.join(ROOT, 'tailwind.config.js');
const TAILWIND_INPUT = path.join(FRONTEND_DIR, 'tailwind-input.css');
const TAILWIND_OUTPUT = path.join(OUT_DIR, 'tailwind.css');
const MAPLIBRE_PACKAGE_PATH = path.join(FRONTEND_DIR, 'node_modules', 'maplibre-gl', 'package.json');
const MAPLIBRE_DIST_DIR = path.join(FRONTEND_DIR, 'node_modules', 'maplibre-gl', 'dist');
const MAPLIBRE_VERSION = JSON.parse(fs.readFileSync(MAPLIBRE_PACKAGE_PATH, 'utf8')).version;
const MAPLIBRE_MAJOR = Number.parseInt(MAPLIBRE_VERSION.split('.')[0], 10);
const MAPLIBRE_RUNTIME_FILES = [
  'maplibre-gl-worker.mjs',
  'maplibre-gl-shared.mjs',
];
const TAILWIND_CLI_CANDIDATES = [
  path.join(ROOT, 'node_modules', 'tailwindcss', 'lib', 'cli.js'),
  path.join(ROOT, 'electron', 'node_modules', 'tailwindcss', 'lib', 'cli.js'),
];
const MIN_TAILWIND_BYTES = 24 * 1024;
const REQUIRED_TAILWIND_MARKERS = [
  '.space-y-5>',
  '.rounded-3xl{',
  '.border-border\\/80{',
  '.bg-panel\\/80{',
  '.shadow-2xl{',
];

const STATIC_FILES = [
  'flight-phases.js',
  'telemetry-ui.js',
];

const STATIC_DIRS = [
  'assets',
  'audio',
  'themes',
  'vendor',
];

process.chdir(ROOT);

function log(message) {
  console.log(`[frontend-build] ${message}`);
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function copyFile(relativePath) {
  const srcPath = path.join(FRONTEND_DIR, relativePath);
  const destPath = path.join(OUT_DIR, relativePath);
  ensureDir(path.dirname(destPath));
  fs.copyFileSync(srcPath, destPath);
}

function copyDir(relativePath) {
  const srcPath = path.join(FRONTEND_DIR, relativePath);
  const destPath = path.join(OUT_DIR, relativePath);
  fs.cpSync(srcPath, destPath, { recursive: true });
}

function copyDirTo(sourceRelativePath, destinationRelativePath) {
  const srcPath = path.join(FRONTEND_DIR, sourceRelativePath);
  const destPath = path.join(OUT_DIR, destinationRelativePath);
  fs.cpSync(srcPath, destPath, { recursive: true });
}

function copyMapLibreRuntimeFiles() {
  if (MAPLIBRE_MAJOR < 6) return;

  for (const fileName of MAPLIBRE_RUNTIME_FILES) {
    const srcPath = path.join(MAPLIBRE_DIST_DIR, fileName);
    const destPath = path.join(OUT_DIR, fileName);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Missing MapLibre runtime dependency: ${srcPath}`);
    }
    fs.copyFileSync(srcPath, destPath);
  }
}

function assertBundledIndexHtml() {
  const indexPath = path.join(OUT_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Missing built index: ${indexPath}`);
  }

  const html = fs.readFileSync(indexPath, 'utf8');
  if (!/src=["']\/main\.js["']/.test(html)) {
    throw new Error('Built frontend index.html is missing the bundled /main.js entry.');
  }
  const retiredEntryFiles = [
    'index-vue.js',
    'index-app.js',
    'index-tabs.js',
    'index-debug.js',
    'index-profiles.js',
    'index-settings.js',
    'index-live-map.js',
    'index-logbook.js',
    'index-timeline.js',
  ];
  const leakedEntryFiles = retiredEntryFiles.filter((entryFile) => html.includes(entryFile));
  if (leakedEntryFiles.length > 0) {
    throw new Error(`Built frontend index.html still references raw source entry files: ${leakedEntryFiles.join(', ')}`);
  }
}

function assertBundledVoiceWorklet() {
  const mainPath = path.join(OUT_DIR, 'main.js');
  const workletPath = path.join(OUT_DIR, 'assets', 'pcm-worklet.js');
  if (!fs.existsSync(mainPath)) {
    throw new Error(`Missing built frontend entry: ${mainPath}`);
  }
  if (!fs.existsSync(workletPath)) {
    throw new Error('PCM AudioWorklet must be emitted as a same-origin asset for the renderer CSP.');
  }

  const main = fs.readFileSync(mainPath, 'utf8');
  if (!main.includes('/assets/pcm-worklet.js')) {
    throw new Error('Built frontend entry does not reference the emitted PCM AudioWorklet asset.');
  }
  if (main.includes('data:text/javascript')) {
    throw new Error('Built frontend contains an inline JavaScript data URL, which the renderer CSP blocks.');
  }

  const worklet = fs.readFileSync(workletPath, 'utf8');
  if (!worklet.includes('registerProcessor') || !worklet.includes('flight-fabric-pcm-capture')) {
    throw new Error('Built PCM AudioWorklet asset is missing its processor registration.');
  }
}

function assertBundledMapLibreRuntime() {
  const mainPath = path.join(OUT_DIR, 'main.js');
  if (!fs.existsSync(mainPath)) {
    throw new Error(`Missing built MapLibre runtime entry: ${mainPath}`);
  }

  const main = fs.readFileSync(mainPath, 'utf8');
  if (MAPLIBRE_MAJOR < 6) {
    if (!main.includes('createObjectURL') || !main.includes('Worker(')) {
      throw new Error(`Built frontend does not contain the MapLibre ${MAPLIBRE_VERSION} embedded worker runtime.`);
    }
    return;
  }

  const workerPath = path.join(OUT_DIR, 'maplibre-gl-worker.mjs');
  const sharedPath = path.join(OUT_DIR, 'maplibre-gl-shared.mjs');

  for (const requiredPath of [mainPath, workerPath, sharedPath]) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`Missing built MapLibre runtime asset: ${requiredPath}`);
    }
  }

  if (!main.includes('maplibre-gl-worker.mjs')) {
    throw new Error('Built frontend entry does not reference the MapLibre module worker.');
  }

  const worker = fs.readFileSync(workerPath, 'utf8');
  if (!worker.includes('./maplibre-gl-shared.mjs')) {
    throw new Error('Built MapLibre worker does not reference its shared runtime module.');
  }
}

function buildBundle() {
  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }

  log('Running Vite production build...');
  execFileSync(process.execPath, [VITE_BIN, 'build', 'frontend', '--configLoader', 'runner'], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  log('Copying compatibility assets...');
  for (const relativePath of STATIC_FILES) {
    copyFile(relativePath);
  }
  for (const relativePath of STATIC_DIRS) {
    copyDir(relativePath);
  }
  copyMapLibreRuntimeFiles();

  buildTailwindCss();

  assertBundledIndexHtml();
  assertBundledVoiceWorklet();
  assertBundledMapLibreRuntime();
  log('Frontend bundle ready.');
}

function buildTailwindCss() {
  const tailwindCli = TAILWIND_CLI_CANDIDATES.find((candidatePath) => fs.existsSync(candidatePath));
  if (!tailwindCli) {
    throw new Error(
      `Missing Tailwind CLI. Checked: ${TAILWIND_CLI_CANDIDATES.join(', ')}. Run npm install in the repo root.`,
    );
  }
  if (!fs.existsSync(TAILWIND_CONFIG)) {
    throw new Error(`Missing Tailwind config: ${TAILWIND_CONFIG}`);
  }
  if (!fs.existsSync(TAILWIND_INPUT)) {
    throw new Error(`Missing Tailwind input: ${TAILWIND_INPUT}`);
  }

  log('Compiling Tailwind CSS...');
  execFileSync(
    process.execPath,
    [tailwindCli, '-c', TAILWIND_CONFIG, '-i', TAILWIND_INPUT, '-o', TAILWIND_OUTPUT, '--minify'],
    {
      cwd: ROOT,
      stdio: 'inherit',
    },
  );

  const { size } = fs.statSync(TAILWIND_OUTPUT);
  if (size < MIN_TAILWIND_BYTES) {
    throw new Error(`Tailwind output too small (${size} bytes). Check tailwind.config.js content globs.`);
  }

  const css = fs.readFileSync(TAILWIND_OUTPUT, 'utf8');
  const missingMarkers = REQUIRED_TAILWIND_MARKERS.filter((marker) => !css.includes(marker));
  if (missingMarkers.length > 0) {
    throw new Error(`Tailwind output is missing expected utility markers: ${missingMarkers.join(', ')}`);
  }
}

buildBundle();
