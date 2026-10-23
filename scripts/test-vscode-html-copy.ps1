param(
  [Parameter(Mandatory=$true)][string]$CodePath,
  [ValidateRange(1024,65535)][int]$Port=9351
)
$ErrorActionPreference='Stop'
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw 'The debugging port is in use; choose another -Port.'
}
$repoRoot=Split-Path $PSScriptRoot -Parent
$codeExecutable=(Resolve-Path -LiteralPath $CodePath).Path
$output=Join-Path $repoRoot ('.local/probes/html-copy-'+[guid]::NewGuid().ToString('N'))
$profileDirectory=Join-Path $output 'profile'
$profileUser=Join-Path $profileDirectory 'User'
$workspace=Join-Path $output 'workspace'
$extensions=Join-Path $output 'extensions'
New-Item -ItemType Directory -Force $profileUser,$workspace,$extensions | Out-Null
'{"git.openRepositoryInParentFolders":"never","workbench.startupEditor":"none","files.autoSave":"off"}' |
  Set-Content -LiteralPath (Join-Path $profileUser 'settings.json') -Encoding utf8
$env:MEO_HTML_COPY_OUTPUT=$output
$env:MEO_HTML_COPY_BROWSER_URL='http://127.0.0.1:'+ $Port
$entry=Join-Path $PSScriptRoot 'test-vscode-html-copy.cjs'
$launchArgs=@('--new-window','--skip-welcome','--skip-release-notes','--disable-updates','--disable-workspace-trust',('--remote-debugging-port='+$Port),('--user-data-dir="'+$profileDirectory+'"'),('--extensions-dir="'+$extensions+'"'),('--extensionDevelopmentPath="'+$repoRoot+'"'),('--extensionTestsPath="'+$entry+'"'),('"'+$workspace+'"'))
$child=Start-Process -FilePath $codeExecutable -ArgumentList $launchArgs -WindowStyle Hidden -RedirectStandardOutput (Join-Path $output 'stdout.log') -RedirectStandardError (Join-Path $output 'stderr.log') -PassThru
try {
  if (-not $child.WaitForExit(150000)) {
    $child.Kill($true)
    throw 'VS Code HTML copy checks timed out after 150 seconds.'
  }
  Write-Output ('Report: '+(Join-Path $output 'result.json'))
  if (Test-Path -LiteralPath (Join-Path $output 'result.json')) {
    Get-Content -LiteralPath (Join-Path $output 'result.json') -Raw
  }
  if ($child.ExitCode -ne 0) { throw ('VS Code HTML copy checks failed with exit code '+$child.ExitCode) }
} finally {
  if (-not $child.HasExited) { $child.Kill($true) }
  Remove-Item Env:MEO_HTML_COPY_OUTPUT,Env:MEO_HTML_COPY_BROWSER_URL -ErrorAction SilentlyContinue
}
