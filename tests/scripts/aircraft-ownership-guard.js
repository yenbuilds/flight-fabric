'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');

// Explicit signals, not a semantic proof. Extend these with a regression when a
// new aircraft family or source convention is introduced.
const AIRCRAFT = /pmdg|fenix|flybywire|fbw|inibuilds|ifly|tfdi|a32nx|a32x|a380|a350|tristar|headwind[-_]?a3\d|workingtitle|justflight|asobo[-_]?787|md[-_]?11/i;
const RAW_VARIABLE = /(?:\b[LSH]:[A-Za-z_]|\b[ASEI]_(?:FCU|FC|OVHD|PED|MIP|ECAM)_)/;
const CONCRETE_IMPORT = /(?:^|[/\\])aircraft-integrations[/\\][^/\\]+[/\\]/;
const ROOTS = ['backend', 'frontend', 'electron', 'shared', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'generated', '.git', 'vendor']);
const SOURCE = /\.(?:[cm]?js|[cm]?ts|tsx|jsx|vue)$/i;
// Existing neutral entry points own dispatch/catalogue assembly. This exact
// list does not permit a new aircraft-specific sibling or raw LVAR recipes.
const DISPATCH_OWNERS = new Set([
  'backend/aircraft/aircraft-command-catalogue.ts',
  'backend/aircraft/aircraft-control-policy.ts',
  'backend/aircraft/aircraft-timeline-projections.ts',
  'backend/aircraft/barometer-execution.ts',
  'backend/aircraft/minimums-execution.ts',
]);

function isTest(file) {
  return /(?:^|\/)(?:tests?|__tests__|fixtures|__fixtures__)(?:\/|$)/.test(file)
    || /(?:^|\/)test-[^/]+\.[^/]+$/.test(file)
    || /\.(?:test|spec)\.[^/]+$/.test(file);
}

function mappingOwner(file) {
  return file.startsWith('backend/aircraft/aircraft-integrations/')
    || file.startsWith('backend/aircraft/profiles/');
}

function transportOwner(file) {
  // Protocol decoding/transport stays at these existing boundaries. Aircraft
  // command procedures still belong in integrations, not new sibling folders.
  return ['backend/telemetry-provider/sdk-adapters/', 'backend/telemetry-provider/sdk-connectors/',
    'backend/telemetry-provider/cdu/'].some(prefix => file.startsWith(prefix));
}

function presentationOwner(file) {
  return ['frontend/src/vue/aircraft-specific/', 'frontend/src/vue/components/aircraft-specific/']
    .some(prefix => file.startsWith(prefix));
}

function listRuntimeFiles(root) {
  const files = [];
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const file = path.relative(root, full).split(path.sep).join('/');
      if (entry.isSymbolicLink() || isTest(file)) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(full);
      } else if ((SOURCE.test(file) || /\.json$/i.test(file)) && !file.endsWith('.d.ts')) {
        // Prefer maintained TS over a generated sibling JS copy.
        if (file.endsWith('.js') && fs.existsSync(full.slice(0, -3) + '.ts')) continue;
        files.push(file);
      }
    }
  }
  for (const dir of ROOTS) visit(path.join(root, dir));
  return files.sort();
}

function scriptSource(file, text) {
  if (!file.endsWith('.vue')) return text;
  // Preserve line numbers and examine both script and script-setup blocks;
  // aircraft labels in template markup aren't control mappings.
  let result = '', end = 0;
  const blank = value => value.replace(/[^\r\n]/g, ' ');
  for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const start = match.index + match[0].indexOf('>') + 1;
    result += blank(text.slice(end, start)) + match[1];
    end = start + match[1].length;
  }
  return result + blank(text.slice(end));
}

function declarationFingerprint(statement, source) {
  function syntax(node) {
    // Syntax structure preserves ASI-sensitive behavior, and literal token text
    // preserves spaces inside strings/regex/templates. Positions and trivia do
    // not participate, so layout or JSDoc edits cannot invalidate an exception.
    const children = node.getChildren(source).filter(child =>
      child.kind < ts.SyntaxKind.FirstJSDocNode || child.kind > ts.SyntaxKind.LastJSDocNode);
    return [node.kind, children.length ? children.map(syntax) : node.getText(source)];
  }
  return createHash('sha256').update(JSON.stringify(syntax(statement))).digest('hex');
}

function inspectSource(file, text) {
  if (isTest(file) || file.endsWith('.d.ts')) return [];
  const mapping = mappingOwner(file), transport = transportOwner(file), presentation = presentationOwner(file);
  const dispatch = DISPATCH_OWNERS.has(file);
  const hits = [];
  if (AIRCRAFT.test(file) && !mapping && !transport && !presentation) {
    hits.push({ rule: 'aircraft-file-placement', file, line: 1, code: file, fingerprint: 'path' });
  }
  if (!SOURCE.test(file)) return hits;
  const source = ts.createSourceFile(file, scriptSource(file, text), ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  for (const statement of source.statements) {
    const rules = new Set();
    function visit(node) {
      // AST values ignore comments, recognize escaped strings and inspect
      // identifiers as well as profile IDs, property keys and template strings.
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)
        || ts.isRegularExpressionLiteral(node)) {
        const value = node.text;
        if (!mapping && !transport && !presentation && !dispatch && AIRCRAFT.test(value)) rules.add('aircraft-source-placement');
        if (!mapping && !transport && RAW_VARIABLE.test(value)) rules.add('aircraft-raw-variable-placement');
        if (!mapping && !dispatch && CONCRETE_IMPORT.test(value)) rules.add('aircraft-concrete-dependency');
      }
      ts.forEachChild(node, visit);
    }
    visit(statement);
    if (!rules.size) continue;
    // Freeze the containing declaration, including bodies and table entries.
    // A token count or matching-line baseline would miss new behavior within
    // an already grandfathered aircraft branch. Comments/formatting don't count.
    const fingerprint = declarationFingerprint(statement, source);
    for (const rule of rules) hits.push({ rule, file, fingerprint,
      line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
      code: statement.getText(source).split(/\r?\n/)[0].slice(0, 180) });
  }
  return hits;
}

function checkOwnership(root, baseline) {
  const failures = [];
  for (const file of listRuntimeFiles(root)) {
    const hits = inspectSource(file, fs.readFileSync(path.join(root, file), 'utf8'));
    const entry = baseline[file];
    // Consume each exact entry once: duplicating an accepted declaration must
    // not inherit its exception. Removals are safe and need no baseline update.
    const remaining = [...(entry?.reason?.trim() ? entry.accepted : [])];
    for (const hit of hits) {
      const key = `${hit.rule}:${hit.fingerprint}`;
      const index = remaining.indexOf(key);
      if (index >= 0) { remaining.splice(index, 1); continue; }
      failures.push({ ...hit, message: 'Aircraft knowledge needs its existing integration/profile owner or a reviewed, narrowly scoped boundary. Existing exceptions do not permit new code; do not refresh the baseline to silence this check.' });
    }
  }
  return failures;
}

module.exports = { inspectSource, listRuntimeFiles, checkOwnership };
