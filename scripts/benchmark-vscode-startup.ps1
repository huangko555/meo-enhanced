param(
  [Parameter(Mandatory=$true)][string]$Document,
  [Parameter(Mandatory=$true)][string]$CodePath,
  [ValidateRange(1024,65535)][int]$Port=9341,
  [switch]$Profile,
  [switch]$Trace,
  [switch]$Visible,
  [switch]$ColdInput,
  [ValidateSet('startup','interaction','reading','lifecycle')][string]$Scenario='startup',
  [ValidateRange(0,2147483647)][int]$ImageLine=0,
  [switch]$ResourceCampaign,
  [switch]$ConfirmLongRun,
  [string]$ImagePath,
  [string]$ExtensionPath
)
$ErrorActionPreference='Stop'
if ($ColdInput -and $Scenario -ne 'interaction') { throw 'ColdInput requires the interaction scenario.' }
if ($ResourceCampaign -and ($Scenario -ne 'lifecycle' -or -not $ConfirmLongRun -or -not $ImagePath)) {
  throw 'ResourceCampaign requires lifecycle, ImagePath and explicit ConfirmLongRun authorization.'
}
if (($ConfirmLongRun -or $ImagePath) -and -not $ResourceCampaign) { throw 'ConfirmLongRun and ImagePath require ResourceCampaign.' }
if ($Profile -and $Scenario -in @('interaction','lifecycle')) { throw 'Interaction and lifecycle samples must run without the startup CPU profiler.' }
if ($Trace -and ($Scenario -ne 'reading' -or $Profile)) { throw 'Trace requires the reading scenario without Profile; collect timings separately.' }
if ($ImageLine -and $Scenario -ne 'reading') { throw 'ImageLine is only used by the reading scenario.' }
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw 'The debugging port is already in use; choose another -Port.'
}
$repoRoot=Split-Path $PSScriptRoot -Parent
if (-not $ExtensionPath) { $ExtensionPath=$repoRoot }
$documentPath=(Resolve-Path -LiteralPath $Document).Path
$codeExecutable=(Resolve-Path -LiteralPath $CodePath).Path
$output=Join-Path $repoRoot ('.local/probes/'+$Scenario+'-'+[guid]::NewGuid().ToString('N'))
$profileDirectory=Join-Path $output 'profile'
$workspace=Join-Path $output 'workspace'
$extensions=Join-Path $output 'extensions'
New-Item -ItemType Directory -Force $profileDirectory,$workspace,$extensions | Out-Null
$env:MEO_PERF_DOCUMENT=$documentPath
$env:MEO_PERF_OUTPUT=$output
$env:MEO_PERF_BROWSER_URL='http://127.0.0.1:'+ $Port
$env:MEO_PERF_PROFILE=if($Profile){'1'}else{'0'}
$env:MEO_PERF_TRACE=if($Trace){'1'}else{'0'}
$env:MEO_PERF_VISIBLE=if($Visible){'1'}else{'0'}
$env:MEO_PERF_COLD_INPUT=if($ColdInput){'1'}else{'0'}
$env:MEO_PERF_IMAGE_LINE=[string]$ImageLine
$env:MEO_PERF_RESOURCE_CAMPAIGN=if($ResourceCampaign){'1'}else{'0'}
$env:MEO_PERF_CONFIRM_LONG_RUN=if($ConfirmLongRun){'1'}else{'0'}
$env:MEO_PERF_IMAGE=if($ImagePath){(Resolve-Path -LiteralPath $ImagePath).Path}else{''}
$entry=Join-Path $PSScriptRoot ('benchmark-vscode-'+$Scenario+'.cjs')
$launchArgs=@('--new-window','--skip-welcome','--skip-release-notes','--disable-updates','--disable-workspace-trust',('--remote-debugging-port='+$Port),('--user-data-dir="'+$profileDirectory+'"'),('--extensions-dir="'+$extensions+'"'),('--extensionDevelopmentPath="'+$ExtensionPath+'"'),('--extensionTestsPath="'+$entry+'"'),('"'+$workspace+'"'))
$windowStyle=if ($Visible) {'Normal'} else {'Hidden'}
$child=Start-Process -FilePath $codeExecutable -ArgumentList $launchArgs -WindowStyle $windowStyle -RedirectStandardOutput (Join-Path $output 'stdout.log') -RedirectStandardError (Join-Path $output 'stderr.log') -PassThru -Wait
Write-Output ('Report: '+(Join-Path $output 'result.json'))
if($child.ExitCode -ne 0){exit $child.ExitCode}
$report=Get-Content (Join-Path $output 'result.json') -Raw | ConvertFrom-Json
if ($Scenario -eq 'startup') { $report.runs | Select-Object phase,max,p95,over50,longMs | ConvertTo-Json }
elseif ($Scenario -eq 'lifecycle') {
  if ($ResourceCampaign) {
    $report | Select-Object passed,originalUnchanged,imageUnchanged,@{Name='completedRounds';Expression={$_.rounds.Count}} | ConvertTo-Json
  } else {
    $report | Select-Object passed,originalUnchanged,richOpenToEditorMs,controlOpenToEditorMs,returnCommandMs,richFrameDetached | ConvertTo-Json
  }
}
else { $report.runs | ConvertTo-Json -Depth 4 }
