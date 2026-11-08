param([Parameter(Mandatory = $true)][string]$PlanPath)
$ErrorActionPreference = 'Stop'
$resolvedPlan = (Resolve-Path -LiteralPath $PlanPath).Path
$directory = Split-Path -Parent $resolvedPlan
$plan = Get-Content -Raw -Encoding UTF8 -LiteralPath $resolvedPlan | ConvertFrom-Json
foreach ($step in $plan.steps) {
  if ($step.command.runtime -ne 'pwsh') { continue }
  $script = if ([IO.Path]::IsPathRooted($step.command.script)) {
    [IO.Path]::GetFullPath($step.command.script)
  } else {
    [IO.Path]::GetFullPath((Join-Path $directory $step.command.script))
  }
  if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "Missing native owner: $script" }
  $tokens = $null
  $parseErrors = $null
  $null = [Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw "$($step.id): $($parseErrors.Message -join '; ')" }
}
Write-Output 'Native PowerShell owners parsed; no owner was executed.'
