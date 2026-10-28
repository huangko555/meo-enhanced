param(
  [Parameter(Mandatory=$true)][string]$CodePath,
  [ValidateRange(1024,65535)][int]$Port=9347,
  [switch]$Large
)
$ErrorActionPreference='Stop'
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw 'The debugging port is already in use; choose another -Port.'
}
$repoRoot=Split-Path $PSScriptRoot -Parent
$codeExecutable=(Resolve-Path -LiteralPath $CodePath).Path
$output=Join-Path $repoRoot ('.local/probes/toolbar-viewport-'+[guid]::NewGuid().ToString('N'))
$profileDirectory=Join-Path $output 'profile'
$profileUser=Join-Path $profileDirectory 'User'
$workspace=Join-Path $output 'workspace'
$extensions=Join-Path $output 'extensions'
New-Item -ItemType Directory -Force $profileUser,$workspace,$extensions | Out-Null
'{"git.openRepositoryInParentFolders":"never","workbench.startupEditor":"none","window.zoomLevel":0}' | Set-Content -LiteralPath (Join-Path $profileUser 'settings.json') -Encoding utf8
$env:MEO_TOOLBAR_OUTPUT=$output
$env:MEO_TOOLBAR_BROWSER_URL='http://127.0.0.1:'+ $Port
$env:MEO_TOOLBAR_LARGE=if($Large){'1'}else{'0'}
$entry=Join-Path $PSScriptRoot 'test-vscode-toolbar-viewport.cjs'
$launchArgs=@('--new-window','--skip-welcome','--skip-release-notes','--disable-updates','--disable-workspace-trust',('--remote-debugging-port='+$Port),('--user-data-dir="'+$profileDirectory+'"'),('--extensions-dir="'+$extensions+'"'),('--extensionDevelopmentPath="'+$repoRoot+'"'),('--extensionTestsPath="'+$entry+'"'),('"'+$workspace+'"'))
$child=Start-Process -FilePath $codeExecutable -ArgumentList $launchArgs -WindowStyle Hidden -RedirectStandardOutput (Join-Path $output 'stdout.log') -RedirectStandardError (Join-Path $output 'stderr.log') -PassThru
try {
  $deadline=[DateTime]::UtcNow.AddSeconds(120)
  while (-not $child.WaitForExit(1000)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'VS Code toolbar checks timed out after 120 seconds.' }
  }
  $result=Join-Path $output 'result.json'
  Write-Output ('Report: '+$result)
  $report=Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
  if ($child.ExitCode -ne 0 -or -not $report.passed) { throw ('VS Code toolbar checks failed: '+$report.error) }
  [pscustomobject]@{passed=$report.passed;vscode=$report.vscode;windowed=$report.optimized;cases=$report.cases.Count;hostFrames=$report.host.Count;appFrames=$report.app.Count} | ConvertTo-Json
} finally {
  if (-not $child.HasExited) { $child.Kill($true) }
  Remove-Item Env:MEO_TOOLBAR_OUTPUT,Env:MEO_TOOLBAR_BROWSER_URL,Env:MEO_TOOLBAR_LARGE -ErrorAction SilentlyContinue
}
