param([Parameter(Mandatory=$true)][string]$InstallerPath, [Parameter(Mandatory=$true)][string]$ExpectedVersion)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Microsoft Corporation(,|$)') {
    throw 'The runtime installer must have a valid Microsoft Corporation Authenticode signature.'
}
$version = (Get-Item -LiteralPath $InstallerPath).VersionInfo.ProductVersion
if ($version -cne $ExpectedVersion) { throw "Unexpected Microsoft runtime version: $version" }
Write-Output 'Microsoft runtime signature and version verified.'
