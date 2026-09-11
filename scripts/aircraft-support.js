#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { profileKey, buildValidationPlan, diffReports, renderReport } = require('./aircraft-support/inventory');
const { captureSession } = require('./aircraft-support/capture');
const { getRepoScratchPath } = require('./repo-scratch');

const ROOT = path.resolve(__dirname, '..');
const HELP = `Aircraft support workbench (developer tooling)

  npm run aircraft:support -- report --profile pmdg-737 [--out-dir .tmp/737-baseline]
  npm run aircraft:support -- diff --before report.json --after report.json [--out diff.json]
  npm run aircraft:support -- capture --report report.json --fields lights.beacon,lights.taxi
    --aircraft-version <installed-version> --simulator-version <installed-version> --condition <starting-state>
    [--seconds 20] [--url ws://127.0.0.1:8099] --out capture.json

report rebuilds the backend and loads definitions with isolated temporary settings,
then exports report.json, report.md and validation-plan.json.
diff identifies contract changes and actions affected by changed commands or observations.
capture only requests existing state and records selected logical fields; it sends no aircraft controls.
Choose the exact loaded profile and supply the aircraft/simulator versions actually installed.
Use the cockpit or Flight Fabric controls yourself during capture. Ctrl+C saves a partial capture.
Capture is limited to the local PC and needs no API key or WebSocket control token.
Limits: 1-64 selected fields, 1-120 seconds (20 by default), and 5,000 samples.
Completion needs two distinct fresh source observations per field and fresh final data;
it does not prove correct cockpit behavior. Ordinary simulator pause may not be reported:
keep the simulator unpaused and stop collection yourself before pausing.
Files contain readable test data and notes, with no automatic upload, encryption or deletion.
Output files are created exclusively; existing evidence is never overwritten.
Exit codes: 0 success/complete capture, 2 partial capture, 1 invalid input/tool failure.
`;

function parseArgs(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) return { command: 'help' };
  const command = argv[0];
  const allowed = {
    report: ['profile', 'out-dir'], diff: ['before', 'after', 'out'],
    capture: ['report', 'fields', 'aircraft-version', 'simulator-version', 'condition', 'seconds', 'url', 'out'],
  }[command];
  if (!allowed) throw new Error('Choose report, diff or capture. Use --help for examples.');
  const args = { command };
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]?.slice(2), value = argv[index + 1];
    if (!argv[index]?.startsWith('--') || !allowed.includes(key) || key in args
      || !value || value.startsWith('--')) throw new Error(`Invalid or duplicate option: ${argv[index]}`);
    args[key] = value;
  }
  const required = { report: ['profile'], diff: ['before', 'after'],
    capture: ['report', 'fields', 'aircraft-version', 'simulator-version', 'condition', 'out'] }[command];
  for (const key of required) if (!args[key]) throw new Error(`--${key} is required.`);
  return args;
}

function readJson(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Expected a JSON file no larger than 32 MB.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeNew(file, content) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
}

function loadReport(keyValue) {
  const key = profileKey(keyValue);
  // Build before isolating the worker so compiler discovery keeps the caller's
  // toolchain environment. This resolver does not import backend config.
  const { resolveBackendRuntimeFile: runtime } = require('./backend-runtime-paths');
  runtime('aircraft/aircraft-profile-loader.js');
  const scratch = getRepoScratchPath('aircraft-support', 'runtime');
  fs.mkdirSync(scratch, { recursive: true });
  const reportHome = fs.mkdtempSync(path.join(scratch, 'report-'));
  const env = { ...process.env, HOME: reportHome, USERPROFILE: reportHome,
    APPDATA: path.join(reportHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(reportHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(reportHome, '.config'),
    OneDrive: reportHome, ONEDRIVE: reportHome, OneDriveConsumer: reportHome, OneDriveCommercial: reportHome,
    FLIGHT_FABRIC_SKIP_WINDOWS_KNOWN_DOCUMENTS: '1' };
  const json = execFileSync(process.execPath, [path.join(__dirname, 'aircraft-support/report-runtime.js'), key], {
    cwd: ROOT, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(json);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === 'help') { process.stdout.write(HELP); return 0; }
  if (args.command === 'report') {
    const key = profileKey(args.profile);
    // Both executable definitions and copied profile JSON must come from this
    // checkout. An old dist directory is not evidence about today's sources.
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-backend-runtime.js')], { cwd: ROOT, stdio: 'inherit' });
    const report = loadReport(key);
    const output = path.resolve(args['out-dir'] || path.join(ROOT, '.tmp/aircraft-support',
      `${key.split('/').at(-1)}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
    const files = { 'report.json': JSON.stringify(report, null, 2) + '\n',
      'report.md': renderReport(report), 'validation-plan.json': JSON.stringify(buildValidationPlan(report), null, 2) + '\n' };
    for (const name of Object.keys(files)) if (fs.existsSync(path.join(output, name))) throw new Error(`Output already exists: ${path.join(output, name)}`);
    for (const [name, content] of Object.entries(files)) writeNew(path.join(output, name), content);
    process.stdout.write(`${report.profileName}: ${report.counts.fields} fields, ${report.counts.actions} actions, ${report.counts.advertisedCommands} commands.\nReport and validation plan: ${output}\n`);
    return 0;
  }
  if (args.command === 'diff') {
    const diff = diffReports(readJson(args.before), readJson(args.after));
    const json = JSON.stringify(diff, null, 2) + '\n';
    if (args.out) writeNew(args.out, json);
    else process.stdout.write(json);
    return 0;
  }
  const report = readJson(args.report);
  // Reuse full report validation, including its hash, without trusting edited cases.
  diffReports(report, report);
  if (fs.existsSync(args.out)) throw new Error('Capture output already exists. Choose a new file.');
  const seconds = Number(args.seconds || 20);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    process.stdout.write(`Observing ${report.contract.profileKey} for ${seconds} seconds. Operate the selected controls yourself.\n`);
    const capture = await captureSession({ report, fieldIds: args.fields.split(',').map(value => value.trim()),
      aircraftVersion: args['aircraft-version'], simulatorVersion: args['simulator-version'], condition: args.condition,
      durationMs: seconds * 1000, url: args.url, signal: controller.signal });
    writeNew(args.out, JSON.stringify(capture, null, 2) + '\n');
    process.stdout.write(`${capture.samples.length} samples saved to ${path.resolve(args.out)} (${capture.endReason}; ${capture.complete ? 'capture complete' : 'partial capture'}).\n`);
    return capture.complete ? 0 : 2;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; })
  .catch(error => { process.stderr.write(`Aircraft support: ${error.message}\n`); process.exitCode = 1; });

module.exports = { main, parseArgs, loadReport };
