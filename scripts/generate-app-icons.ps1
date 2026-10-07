param([switch]$Check)

$ErrorActionPreference = "Stop"

# Compatibility entry point: every surface now comes from the same SVG master.
$generator = Join-Path $PSScriptRoot "generate-app-icons.js"
if ($Check) {
  & node $generator --check
} else {
  & node $generator
}
exit $LASTEXITCODE
