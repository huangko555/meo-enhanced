param(
  [Parameter(Mandatory=$true)][string]$Document,
  [Parameter(Mandatory=$true)][string]$CodePath,
  [ValidateRange(1024,65535)][int]$Port=9341,
  [switch]$Profile,
  [switch]$Trace,
  [switch]$Visible,
  [ValidateSet('startup','interaction','reading')][string]$Scenario='startup',
  [ValidateRange(0,2147483647)][int]$ImageLine=0,
  [string]$ExtensionPath
)
$ErrorActionPreference='Stop'
if ($Profile -and $Scenario -eq 'interaction') { throw 'Interaction samples must run without the startup CPU profiler.' }
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
$env:MEO_PERF_IMAGE_LINE=[string]$ImageLine
$entry=Join-Path $PSScriptRoot ('benchmark-vscode-'+$Scenario+'.cjs')
$launchArgs=@('--new-window','--skip-welcome','--skip-release-notes','--disable-updates','--disable-workspace-trust',('--remote-debugging-port='+$Port),('--user-data-dir="'+$profileDirectory+'"'),('--extensions-dir="'+$extensions+'"'),('--extensionDevelopmentPath="'+$ExtensionPath+'"'),('--extensionTestsPath="'+$entry+'"'),('"'+$workspace+'"'))
$windowStyle=if ($Visible) {'Normal'} else {'Hidden'}
$child=Start-Process -FilePath $codeExecutable -ArgumentList $launchArgs -WindowStyle $windowStyle -RedirectStandardOutput (Join-Path $output 'stdout.log') -RedirectStandardError (Join-Path $output 'stderr.log') -PassThru -Wait
Write-Output ('Report: '+(Join-Path $output 'result.json'))
if($child.ExitCode -ne 0){exit $child.ExitCode}
$report=Get-Content (Join-Path $output 'result.json') -Raw | ConvertFrom-Json
if ($Scenario -eq 'startup') { $report.runs | Select-Object phase,max,p95,over50,longMs | ConvertTo-Json }
else { $report.runs | ConvertTo-Json -Depth 4 }
