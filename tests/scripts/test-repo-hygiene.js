#!/usr/bin/env node
// Fails when generated, local, or private files covered by .gitignore are still
// tracked by Git. This keeps build output and machine-local config out of the
// code review surface.

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function isGitCheckout() {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch (error) {
    return false;
  }
}

function listTrackedIgnoredFiles() {
  const output = execFileSync('git', ['ls-files', '-ci', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function listTrackedFiles(...patterns) {
  const output = execFileSync('git', ['ls-files', '--', ...patterns], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function normalizeMarkdownLinkTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith('<')) {
    const close = target.indexOf('>');
    if (close !== -1) target = target.slice(1, close);
  } else {
    target = target.split(/\s+["']/u, 1)[0];
  }

  if (
    !target ||
    target.startsWith('#') ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)
  ) {
    return null;
  }

  target = target.split('#', 1)[0].split('?', 1)[0];
  if (!target) return null;

  try {
    return decodeURIComponent(target);
  } catch (error) {
    return target;
  }
}

function assertTrackedMarkdownLinksResolve() {
  const markdownFiles = listTrackedFiles('*.md', '*.mdx');
  const errors = [];
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/gu;

  for (const relativeFile of markdownFiles) {
    const absoluteFile = path.join(ROOT, relativeFile);
    if (!fs.existsSync(absoluteFile)) continue;
    const markdown = fs.readFileSync(absoluteFile, 'utf8');

    for (const match of markdown.matchAll(linkPattern)) {
      const target = normalizeMarkdownLinkTarget(match[1]);
      if (!target) continue;

      const resolved = target.startsWith('/')
        ? path.resolve(ROOT, `.${target}`)
        : path.resolve(path.dirname(absoluteFile), target);
      const relativeResolved = path.relative(ROOT, resolved);
      if (
        relativeResolved.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeResolved)
      ) {
        errors.push(
          `${relativeFile}:${lineNumberAt(markdown, match.index)} links outside the repository: ${target}`,
        );
        continue;
      }

      if (!fs.existsSync(resolved)) {
        errors.push(
          `${relativeFile}:${lineNumberAt(markdown, match.index)} missing local link target: ${target}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error('Tracked Markdown link hygiene failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log(`  PASS ${markdownFiles.length} tracked Markdown files have valid local links`);
}

function collectTrackedNpmScripts() {
  const scripts = new Set();
  for (const relativeFile of listTrackedFiles('package.json', '*/package.json', '*/*/package.json')) {
    const absoluteFile = path.join(ROOT, relativeFile);
    if (!fs.existsSync(absoluteFile)) continue;
    const manifest = JSON.parse(fs.readFileSync(absoluteFile, 'utf8'));
    for (const name of Object.keys(manifest.scripts || {})) scripts.add(name);
  }
  return scripts;
}

function assertDocumentedNpmScriptsExist() {
  const knownScripts = collectTrackedNpmScripts();
  const markdownFiles = listTrackedFiles('*.md', '*.mdx');
  const errors = [];
  const fencePattern = /```[^\r\n]*\r?\n([\s\S]*?)```/gu;
  const commandPattern = /\bnpm(?:\.cmd)?\s+run\s+([A-Za-z0-9:_-]+)/gu;

  for (const relativeFile of markdownFiles) {
    const absoluteFile = path.join(ROOT, relativeFile);
    if (!fs.existsSync(absoluteFile)) continue;
    const markdown = fs.readFileSync(absoluteFile, 'utf8');
    for (const fenceMatch of markdown.matchAll(fencePattern)) {
      for (const commandMatch of fenceMatch[1].matchAll(commandPattern)) {
        const script = commandMatch[1];
        if (knownScripts.has(script)) continue;
        const commandIndex = fenceMatch.index + commandMatch.index;
        errors.push(
          `${relativeFile}:${lineNumberAt(markdown, commandIndex)} documents missing npm script: ${script}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error('Documented npm command hygiene failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log('  PASS npm scripts documented in fenced examples exist in a tracked package manifest');
}

function assertRetiredLiveSharingDeploymentIsAbsent() {
  const workflowsDir = path.join(ROOT, '.github', 'workflows');
  if (!fs.existsSync(workflowsDir)) {
    console.log('  SKIP workflow hygiene (.github/workflows absent from this checkout)');
    return;
  }

  const forbidden = [
    {
      pattern: /live-sharing[\\/]server/iu,
      label: 'retired live-sharing server source',
    },
    {
      pattern: /\bff-live-sharing\b/iu,
      label: 'retired ff-live-sharing process',
    },
    {
      pattern: /\bpm2\b/iu,
      label: 'retired PM2 deployment',
    },
    {
      pattern: /\b(?:DEPLOY_PATH|APP_PORT|MAX_CONNECTIONS|RATE_LIMIT_MS|HEARTBEAT_MS|POSITION_TTL_MS|LIVE_SHARING_INGEST_TOKEN|LANDING_RATE_LIMIT_MS|LANDING_DEDUPE_MS|LANDING_POSITION_MAX_AGE_MS|LANDING_IP_LIMIT_PER_HOUR|LANDING_GLOBAL_LIMIT_PER_MIN|INBOUND_RATE_LIMIT_PER_MIN|INVALID_MESSAGE_LIMIT|TRUST_PROXY|TRAIL_RETENTION_H|LIVE_SHARING_PUBLIC_URL)\b/iu,
      label: 'retired live-sharing deploy identifier or secret',
    },
  ];
  const errors = [];
  const workflowFiles = fs.readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/iu.test(name))
    .sort();

  for (const name of workflowFiles) {
    const relativeFile = path.posix.join('.github', 'workflows', name);
    const workflow = fs.readFileSync(path.join(workflowsDir, name), 'utf8');
    for (const rule of forbidden) {
      const index = workflow.search(rule.pattern);
      if (index === -1) continue;
      errors.push(
        `${relativeFile}:${lineNumberAt(workflow, index)} contains ${rule.label}`,
      );
    }
  }

  if (errors.length > 0) {
    console.error('Retired live-sharing workflow hygiene failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log(`  PASS ${workflowFiles.length} active workflows omit retired live-sharing deployment`);
}

function assertGeneratedTelemetryDeclarationsHaveSources() {
  const generatedRoot = path.join(ROOT, 'backend', 'types', 'generated', 'telemetry-provider');
  if (!fs.existsSync(generatedRoot)) {
    console.log('  SKIP generated telemetry declaration hygiene (generated output absent)');
    return;
  }

  const pending = [generatedRoot];
  const errors = [];
  let declarationCount = 0;

  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;

      declarationCount += 1;
      const relativeDeclaration = path.relative(generatedRoot, absolute);
      const relativeSource = path.join(
        'backend',
        'telemetry-provider',
        relativeDeclaration.replace(/\.d\.ts$/u, '.ts'),
      );
      if (!fs.existsSync(path.join(ROOT, relativeSource))) {
        errors.push(
          `${path.relative(ROOT, absolute).replaceAll(path.sep, '/')} has no source `
            + `${relativeSource.replaceAll(path.sep, '/')}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error('Generated telemetry declaration hygiene failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log(`  PASS ${declarationCount} generated telemetry declarations have source files`);
}

function parseIsoDateToUtc(dateText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function assertChangelogDatesAreSane() {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    console.log('  SKIP changelog date hygiene (CHANGELOG.md absent from this checkout)');
    return;
  }

  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const headerPattern = /^## \[[^\]]+\] - (\d{4}-\d{2}-\d{2})$/gm;
  const today = new Date();
  const todayUtc = new Date(
    Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()),
  );
  let previous = null;
  const errors = [];

  for (const match of changelog.matchAll(headerPattern)) {
    const dateText = match[1];
    const date = parseIsoDateToUtc(dateText);
    const line = changelog.slice(0, match.index).split(/\r?\n/).length;

    if (!date) {
      errors.push(`line ${line}: invalid changelog date ${dateText}`);
      continue;
    }

    if (date > todayUtc) {
      errors.push(`line ${line}: changelog date ${dateText} is in the future`);
    }

    if (previous && date > previous.date) {
      errors.push(
        `line ${line}: changelog date ${dateText} is newer than previous header ${previous.dateText}`,
      );
    }

    previous = { date, dateText };
  }

  if (errors.length > 0) {
    console.error('Changelog date hygiene failed:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('  PASS changelog dates are not future-dated and remain newest-first');
}

if (!isGitCheckout()) {
  console.log('  SKIP repo hygiene requires a Git checkout; generated public mirrors may omit .git');
  process.exit(0);
}

const offenders = listTrackedIgnoredFiles();

if (offenders.length > 0) {
  console.error('Tracked files match .gitignore and should be removed from Git:');
  for (const file of offenders) {
    console.error(`  - ${file}`);
  }
  process.exit(1);
}

console.log('  PASS no tracked files match .gitignore');
assertChangelogDatesAreSane();
assertTrackedMarkdownLinksResolve();
assertDocumentedNpmScriptsExist();
assertRetiredLiveSharingDeploymentIsAbsent();
assertGeneratedTelemetryDeclarationsHaveSources();
