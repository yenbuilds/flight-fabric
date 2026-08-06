# Security Policy

## Supported versions

Security fixes are prioritized for the latest release line on `main`.

## Local filesystem safety

Flight Fabric stores application data and flight logs in documented locations.
A folder name alone is not treated as proof that Flight Fabric owns everything
inside it. Code that writes or deletes files must validate the resolved path,
filename, extension, and allowed root first. Cleanup must never recursively
delete a broad `Flight Fabric` folder.

Current protections:

- Application state writes and deletions use `backend/utils/safe-fs.ts` to
  check the allowed root, filename or extension, regular file target, and
  symbolic links in parent directories.
- Active recording streams and route recording renames use
  `backend/flight-recording/recording-path-guard.ts`; flight CSV and automation
  JSONL files must be direct children of the selected flight log folder.
- Flight deletion can remove only the selected Flight Fabric recording bundle:
  its authoritative CSV, verified automation and aircraft-specific JSONL
  companions, completion status, history summary, and derived timeline. The
  delete transaction validates the bundle directory, exact member names, and
  recording identity before staging that one bundle for removal. It never
  recursively deletes the flight-log root.

## Automated security checks

The `Security scans` GitHub Actions workflow runs on pull requests, pushes to
`main`, a weekly schedule, and manual dispatch. It performs:

- Semgrep static analysis using the checked-in `.semgrep.yml` policy for
  serious Electron, JavaScript, and SQLite connection issues. SQLite rules
  reject direct dynamic query construction and attempts to disable connection
  hardening. The scanner image and rules are both version-controlled, so pull
  requests use the same policy as local scans.
- A SQLite database-doctor test builds the production history-index schema and
  checks connection settings, quick and full integrity, foreign-key validity,
  and foreign-key child-index coverage.
- OSV-Scanner checks across all npm and Cargo lockfiles.
- Gitleaks scanning across Git history with secret values kept out of artifacts.
  `.gitleaksignore` contains only exact fingerprints for reviewed test fixtures
  and deleted non-operational reference material; broad secret-rule exclusions
  are not permitted.
- zizmor analysis of GitHub Actions and Dependabot configuration.

Dependabot checks the npm, Cargo, and GitHub Actions dependency roots monthly
and opens grouped pull requests for review. It does not merge changes
automatically.

Useful commands for local investigation:

```text
semgrep scan --oss-only --config .semgrep.yml --metrics=off --error --severity ERROR .
npm run test:sqlite:doctor
osv-scanner scan source --recursive .
gitleaks git --redact .
zizmor .
```

Do not run automatic scanner remediation or force dependency upgrades without
reviewing the proposed changes and running the relevant test suites.

## Reporting a vulnerability

Please report vulnerabilities privately.

The preferred option is GitHub Security Advisories for this repository. Choose
**Report a vulnerability** on GitHub.

If that is unavailable, open a short public issue asking maintainers for a
private contact channel. Do not include exploit details in the issue.

## What to include

- Affected components
- Reproduction steps or a proof of concept
- Expected impact
- Suggested remediation (if known)
