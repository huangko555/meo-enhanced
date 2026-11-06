param(
  [Parameter(Mandatory = $true)][string]$CodePath,
  [ValidateRange(1024, 65535)][int]$Port = 9359
)
$ErrorActionPreference = 'Stop'
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw 'The debugging port is already in use.'
}
$repoRoot = Split-Path $PSScriptRoot -Parent
$output = Join-Path $repoRoot ('tmp/sidebar-outline-native-' + [guid]::NewGuid().ToString('N'))
$profile = Join-Path $output 'profile'
$workspace = Join-Path $output 'workspace'
$extensions = Join-Path $output 'extensions'
New-Item -ItemType Directory -Force (Join-Path $profile 'User'), $workspace, $extensions | Out-Null
'{"workbench.startupEditor":"none","git.openRepositoryInParentFolders":"never"}' |
  Set-Content -LiteralPath (Join-Path $profile 'User/settings.json') -Encoding UTF8
$env:MEO_OUTLINE_OUTPUT = $output
$env:MEO_OUTLINE_BROWSER_URL = 'http://127.0.0.1:' + $Port
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$arguments = @(
  '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-updates',
  ('--remote-debugging-port=' + $Port),
  ('--user-data-dir="' + $profile + '"'),
  ('--extensions-dir="' + $extensions + '"'),
  ('--extensionDevelopmentPath="' + $repoRoot + '"'),
  ('--extensionTestsPath="' + (Join-Path $PSScriptRoot 'test-vscode-sidebar-outline.cjs') + '"'),
  ('"' + $workspace + '"')
)
$child = $null
try {
 foreach ($phase in @('full', 'restore')) {
  $env:MEO_OUTLINE_PHASE = $phase
  $child = Start-Process -FilePath (Resolve-Path -LiteralPath $CodePath).Path -ArgumentList $arguments -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $output ($phase + '-stdout.log')) -RedirectStandardError (Join-Path $output ($phase + '-stderr.log')) -PassThru
  # Retain the process handle so Windows PowerShell can read ExitCode after exit.
  $null = $child.Handle
  # The full owner separately admits a cold split before its unchanged feature
  # budgets. The outer process guard must leave time to finish those checks.
  $phaseTimeout = if ($phase -eq 'full') { 360 } else { 120 }
  $deadline = [DateTime]::UtcNow.AddSeconds($phaseTimeout)
  while (-not $child.WaitForExit(1000)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Native sidebar outline checks timed out.' }
  }
  $reportName = if ($phase -eq 'restore') { 'result-restore.json' } else { 'result.json' }
  $reportPath = Join-Path $output $reportName
  Write-Output ('Report ' + $reportPath)
  $report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -eq $child.ExitCode -or $child.ExitCode -ne 0 -or -not $report.passed) {
    throw ('Native sidebar outline checks failed (exit ' + $child.ExitCode + '). ' + $report.error)
  }
  $report | ConvertTo-Json -Depth 4
 }
} finally {
  if ($null -ne $child -and -not $child.HasExited) { & taskkill.exe /PID $child.Id /T /F | Out-Null }
  Remove-Item Env:MEO_OUTLINE_OUTPUT, Env:MEO_OUTLINE_BROWSER_URL, Env:MEO_OUTLINE_PHASE -ErrorAction SilentlyContinue
}
