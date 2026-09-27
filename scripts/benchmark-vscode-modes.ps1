param(
  [Parameter(Mandatory=$true)][string]$CaseFile,
  [Parameter(Mandatory=$true)][string]$CodePath,
  [ValidateRange(1024,65535)][int]$Port=9341,
  [switch]$ConfirmLongRun
)
$ErrorActionPreference='Stop'
if (-not $ConfirmLongRun) { throw 'Native repeated mode measurement requires ConfirmLongRun authorization.' }
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw 'Debug port is already in use.' }
$repoRoot=Split-Path $PSScriptRoot -Parent
$configPath=(Resolve-Path -LiteralPath $CaseFile).Path
$config=Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
if ($config.savedMode -notin @('live','source','preview') -or $config.expectedMode -notin @('live','source','preview')) { throw 'Invalid mode.' }
if ($config.optimization -isnot [bool] -or $config.restore -isnot [bool]) { throw 'optimization and restore must be booleans.' }
$null=Get-Command bun -ErrorAction Stop
$codeExecutable=(Resolve-Path -LiteralPath $CodePath).Path
$output=Join-Path $repoRoot ('.local/probes/native-modes-'+[guid]::NewGuid().ToString('N'))
$profileDirectory=Join-Path $output 'profile'
$workspace=Join-Path $output 'workspace'
$extensions=Join-Path $output 'extensions'
$settingsDirectory=Join-Path $profileDirectory 'User'
New-Item -ItemType Directory -Force $settingsDirectory,$workspace,$extensions | Out-Null
$settings=@{
  'meoEnhanced.performance.largeDocumentOptimization'=[bool]$config.optimization
  'meoEnhanced.readingPosition.restoreOnOpen'=[bool]$config.restore
  'window.restoreWindows'='none'
  'workbench.startupEditor'='none'
  'security.workspace.trust.enabled'=$false
  'telemetry.telemetryLevel'='off'
}
$settings | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $settingsDirectory 'settings.json') -Encoding utf8
$env:MEO_MODES_CASE=$configPath
$env:MEO_PERF_OUTPUT=$output
$env:MEO_PERF_BROWSER_URL='http://127.0.0.1:'+$Port
$entry=Join-Path $PSScriptRoot 'benchmark-vscode-modes.cjs'
# --extensionTestsPath uses in-memory storage. A companion development extension
# preserves real mode/reading-position persistence across process restarts.
$driver=Join-Path $output 'driver'
New-Item -ItemType Directory -Force $driver | Out-Null
@{name='native-mode-probe';publisher='local-probe';version='0.0.0';engines=@{vscode='^1.90.0'};main='index.cjs';activationEvents=@('onStartupFinished')} | ConvertTo-Json | Set-Content (Join-Path $driver 'package.json') -Encoding utf8
$entryLiteral=ConvertTo-Json -InputObject $entry -Compress
$bootstrap="exports.activate=async()=>{try{await require($entryLiteral).run();}catch(error){console.error(error);}finally{await require('vscode').commands.executeCommand('workbench.action.quit');}};"
Set-Content -LiteralPath (Join-Path $driver 'index.cjs') -Value $bootstrap -Encoding utf8
foreach ($phase in @('seed','measure')) {
  # Seed an existing remembered position even when measurement disables restore.
  $settings['meoEnhanced.readingPosition.restoreOnOpen']=if($phase -eq 'seed'){$true}else{[bool]$config.restore}
  $settings | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $settingsDirectory 'settings.json') -Encoding utf8
  $env:MEO_MODES_PHASE=$phase
  $env:MEO_MODES_LAUNCHED_AT=[string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $launchArgs=@('--new-window','--skip-welcome','--skip-release-notes','--disable-updates','--disable-workspace-trust',('--remote-debugging-port='+$Port),('--user-data-dir="'+$profileDirectory+'"'),('--extensions-dir="'+$extensions+'"'),('--extensionDevelopmentPath="'+$repoRoot+'"'),('--extensionDevelopmentPath="'+$driver+'"'),('"'+$workspace+'"'))
  $child=Start-Process -FilePath $codeExecutable -ArgumentList $launchArgs -WindowStyle Hidden -RedirectStandardOutput (Join-Path $output ($phase+'.stdout.log')) -RedirectStandardError (Join-Path $output ($phase+'.stderr.log')) -PassThru
  if (-not $child.WaitForExit(180000)) {
    $child.Kill($true)
    throw "Native $phase exceeded 180 seconds: $output"
  }
  if ($child.ExitCode -ne 0) { throw "Native $phase failed ($($child.ExitCode)); see $output" }
  $report=Get-Content -Raw -LiteralPath (Join-Path $output ($phase+'.json')) | ConvertFrom-Json
  if (-not $report.passed -or -not $report.originalUnchanged) { throw "Native $phase did not pass: $output" }
  if ($phase -eq 'seed') {
    Get-ChildItem -LiteralPath (Join-Path $profileDirectory 'User') -Recurse -Filter state.vscdb | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $output ('seed-state-'+$_.Directory.Name+'.vscdb'))
    }
    & bun (Join-Path $PSScriptRoot 'benchmark-vscode-seed-state.ts') $output
    if ($LASTEXITCODE -ne 0) { throw "Native seed persistence prerequisite failed: $output" }
  }
}
Write-Output ('Report: '+(Join-Path $output 'measure.json'))
$report.opens | Select-Object kind,expected,openToReadyMs,launchToReadyMs | ConvertTo-Json
