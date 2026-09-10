#!/usr/bin/env node
'use strict';

// Read-only comparison. Uses the same full-flight preview path as Review
// scoring; never applies a rescore or edits a recording/sidecar.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveBackendRuntimeFile } = require('./backend-runtime-paths');
const timelineGenerator = require(resolveBackendRuntimeFile('events', 'timeline-generator.js'));

async function main() {
  const count = Math.max(1, Math.min(200, Number(process.argv[2]) || 20));
  const root = process.argv[3] || path.join(process.env.USERPROFILE, 'Documents', 'Flight Fabric', 'Flight Logs');
  const paths = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name, 'telemetry.csv')).filter(file => fs.existsSync(file)).sort().reverse().slice(0, count);
  const report = [];
  for (const file of paths) {
    const hash = async () => {
      const digest = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
      return digest.digest('hex');
    };
    const beforeHash = await hash();
    const recorded = await timelineGenerator._generateFromCSVInProcess(file, { scoringMode: 'recorded' });
    const preview = await timelineGenerator._generateFromCSVInProcess(file, { scoringMode: 'current-preview' });
    const oldLandings = recorded.timeline?.events.filter(event => event.type === 'landing') || [];
    const newLandings = preview.timeline?.events.filter(event => event.type === 'landing') || [];
    report.push({ recording: path.basename(path.dirname(file)), sourceUnchanged: beforeHash === await hash(),
      success: recorded.success && preview.success,
      error: recorded.error || preview.error || null,
      landings: newLandings.map((landing, index) => {
        const old = oldLandings[index]?.ultimateStability;
        const current = landing.ultimateStability;
        const assessment = current?.scoringContext?.assessment;
        return { profile: current?.scoringContext?.profile?.id, oldScore: old?.score ?? null, oldVerdict: old?.verdict,
          score: current?.score ?? null, verdict: current?.verdict, failures: current?.gateFailures,
          groups: assessment?.groups, coverage: assessment?.window?.coverage,
          episodes: assessment?.episodes.map(episode => ({ rule: episode.ruleId, severity: episode.severity,
            exceedanceSeconds: episode.exceedanceMs / 1000, startHeightFt: Math.round(episode.startHeightFt) })) || [],
          timelineEpisodeCount: preview.timeline.events.filter(event => event.type === 'violation_start'
            && event.context?.assessment_version === 4 && event.timestampMs >= assessment?.window?.startMs
            && event.timestampMs <= assessment?.window?.endMs).length,
        };
      }),
    });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
