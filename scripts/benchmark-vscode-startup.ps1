param(
  [Parameter(Mandatory=$true)][string]$Document,
  [Parameter(Mandatory=$true)][string]$CodePath,
  [ValidateRange(1024,65535)][int]$Port=9341,
  [switch]$Profile,
  [switch]$Visible,
  [string]$ExtensionPath
)
$ErrorActionPreference='Stop'
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw 'The debugging port is already in use; choose another -Port.'
}
$repoRoot=Split-Path $PSScriptRoot -Parent
if (-not $ExtensionPath) { $ExtensionPath=$repoRoot }
$documentPath=(Resolve-Path -LiteralPath $Document).Path
$codeExecutable=(Resolve-Path -LiteralPath $CodePath).Path
$output=Join-Path $repoRoot ('.local/probes/startup-'+[guid]::NewGuid().ToString('N'))
$profileDirectory=Join-Path $output 'profile'
$workspace=Join-Path $output 'workspace'
$extensions=Join-Path $output 'extensions'
New-Item -ItemType Directory -Force $profileDirectory,$workspace,$extensions | Out-Null
$env:MEO_PERF_DOCUMENT=$documentPath
$env:MEO_PERF_OUTPUT=$output
$env:MEO_PERF_BROWSER_URL='http://127.0.0.1:'+ $Port
$env:MEO_PERF_PROFILE=if($Profile){'1'}else{'0'}
$env:MEO_PERF_VISIBLE=if($Visible){'1'}else{'0'}
$launchArgs=@('--new-window','--skip-welcome','--skip-release-notes','--disable-updates','--disable-workspace-trust',('--remote-debugging-port='+$Port),('--user-data-dir="'+$profileDirectory+'"'),('--extensions-dir="'+$extensions+'"'),('--extensionDevelopmentPath="'+$ExtensionPath+'"'),('--extensionTestsPath="'+(Join-Path $PSScriptRoot 'benchmark-vscode-startup.cjs')+'"'),('"'+$workspace+'"'))
$windowStyle=if ($Visible) {'Normal'} else {'Hidden'}
$child=Start-Process -FilePath $codeExecutable -ArgumentList $launchArgs -WindowStyle $windowStyle -RedirectStandardOutput (Join-Path $output 'stdout.log') -RedirectStandardError (Join-Path $output 'stderr.log') -PassThru -Wait
Write-Output ('Report: '+(Join-Path $output 'result.json'))
if($child.ExitCode -ne 0){exit $child.ExitCode}
$report=Get-Content (Join-Path $output 'result.json') -Raw | ConvertFrom-Json
$report.runs | Select-Object phase,max,p95,over50,longMs | ConvertTo-Json
