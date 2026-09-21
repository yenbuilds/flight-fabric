#!/usr/bin/env node
'use strict';

// Turns the "What's new" list in RELEASE_NOTES.md into the small JSON the
// app shows once after an update. Parsing the notes, rather than keeping a
// second list, means the card can never say something the notes do not.

const REPO_URL = 'https://github.com/yenbuilds/flight-fabric';
const HEADING_PATTERN = /^# FlightFabric (\d+\.\d+\.\d+)\b/m;
const SECTION_PATTERN = /^## What'?s new\s*$/im;

function stripMarkdown(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLabel(item) {
  // "**Label:** rest" becomes { label: "Label", text: "rest" }.
  const match = item.match(/^\*\*([^*]+?):?\*\*:?\s*(.*)$/s);
  if (!match) return { label: '', text: stripMarkdown(item) };
  return { label: stripMarkdown(match[1]).replace(/:$/, ''), text: stripMarkdown(match[2]) };
}

function parseWhatsNew(markdown) {
  const source = String(markdown || '').replace(/\r\n/g, '\n');
  const versionMatch = source.match(HEADING_PATTERN);
  if (!versionMatch) throw new Error('RELEASE_NOTES.md must start with "# FlightFabric <version>".');
  const sectionMatch = source.match(SECTION_PATTERN);
  if (!sectionMatch) throw new Error('RELEASE_NOTES.md is missing a "## What\'s new" section.');

  const body = source.slice(sectionMatch.index + sectionMatch[0].length);
  const items = [];
  for (const line of body.split('\n')) {
    if (/^(#{1,6}\s|<details|<summary)/.test(line)) break;
    if (/^- /.test(line)) {
      items.push(line.slice(2));
    } else if (items.length && /^\s{2,}\S/.test(line)) {
      items[items.length - 1] += ` ${line.trim()}`;
    } else if (items.length && line.trim() === '') {
      continue;
    } else if (items.length && line.trim()) {
      break;
    }
  }
  const highlights = items.map(splitLabel).filter((item) => item.text);
  if (!highlights.length) throw new Error('RELEASE_NOTES.md "What\'s new" section has no list items.');
  return { version: versionMatch[1], highlights };
}

function buildWhatsNew(markdown) {
  const parsed = parseWhatsNew(markdown);
  return {
    version: parsed.version,
    releaseNotesUrl: `${REPO_URL}/releases/tag/v${parsed.version}`,
    highlights: parsed.highlights,
  };
}

module.exports = { buildWhatsNew, parseWhatsNew, stripMarkdown };
