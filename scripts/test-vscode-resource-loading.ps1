param(
  [Parameter(Mandatory = $true)][string]$CodePath,
  [ValidateRange(1024, 65535)][int]$Port = 9363
)
$ErrorActionPreference = 'Stop'
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw 'The debugging port is already in use.' }
$repoRoot = Split-Path $PSScriptRoot -Parent
$output = Join-Path $repoRoot ('tmp/resource-loading-native-' + [guid]::NewGuid().ToString('N'))
$profile = Join-Path $output 'profile'
$extensions = Join-Path $output 'extensions'
$workspace = Join-Path $output 'workspace'
New-Item -ItemType Directory -Force (Join-Path $profile 'User'), $workspace, $extensions | Out-Null
'{"workbench.startupEditor":"none","git.openRepositoryInParentFolders":"never","telemetry.telemetryLevel":"off"}' |
  Set-Content -LiteralPath (Join-Path $profile 'User/settings.json') -Encoding UTF8
$env:MEO_RESOURCE_OUTPUT = $output
$env:MEO_RESOURCE_BROWSER_URL = 'http://127.0.0.1:' + $Port
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$arguments = @('--new-window', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-workspace-trust',
  ('--remote-debugging-port=' + $Port), ('--user-data-dir="' + $profile + '"'), ('--extensions-dir="' + $extensions + '"'),
  ('--extensionDevelopmentPath="' + $repoRoot + '"'),
  ('--extensionTestsPath="' + (Join-Path $PSScriptRoot 'test-vscode-resource-loading.cjs') + '"'), ('"' + $workspace + '"'))
$child = $null
try {
  $child = Start-Process -FilePath (Resolve-Path -LiteralPath $CodePath).Path -ArgumentList $arguments -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $output 'stdout.log') -RedirectStandardError (Join-Path $output 'stderr.log') -PassThru
  $null = $child.Handle
  if (-not $child.WaitForExit(180000)) { throw ('Native resource checks timed out: ' + $output) }
  $reportPath = Join-Path $output 'result.json'
  Write-Output ('Report: ' + $reportPath)
  $report = Get-Content -Raw -LiteralPath $reportPath -Encoding UTF8 | ConvertFrom-Json
  $report | ConvertTo-Json -Depth 6
  if ($child.ExitCode -ne 0 -or -not $report.passed) { throw 'Native resource loading checks failed.' }
} finally {
  if ($null -ne $child -and -not $child.HasExited) { $child.Kill($true) }
  Remove-Item Env:MEO_RESOURCE_OUTPUT, Env:MEO_RESOURCE_BROWSER_URL -ErrorAction SilentlyContinue
}
