<#
.SYNOPSIS
  Rebuild the atlas from JourneyMap and push it to GitHub.

.DESCRIPTION
  Run this from a clone of the repo. It reads your JourneyMap folder, rebuilds
  data/, and commits and pushes whatever changed. Nothing happens if the map
  hasn't moved.

  First run:
      git clone https://github.com/alexlynn12/journeymap-atlas.git
      cd journeymap-atlas
      .\tools\sync.ps1

  Schedule it daily (run once, from the repo folder):
      .\tools\sync.ps1 -InstallSchedule -At 04:00

.PARAMETER JourneyMap
  Path to the journeymap folder. Defaults to %APPDATA%\.minecraft\journeymap.

.PARAMETER World
  World folder name, if JourneyMap has mapped more than one.

.PARAMETER InstallSchedule
  Register a daily Windows scheduled task that runs this script, then exit.

.PARAMETER At
  Time of day for -InstallSchedule, as HH:mm. Defaults to 04:00.
#>

[CmdletBinding()]
param(
  [string]$JourneyMap = (Join-Path $env:APPDATA ".minecraft\journeymap"),
  [string]$World,
  [switch]$InstallSchedule,
  [string]$At = "04:00"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

function Need($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "$name is not on PATH. $hint"
  }
}

if ($InstallSchedule) {
  $script = Join-Path $PSScriptRoot "sync.ps1"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
  $trigger = New-ScheduledTaskTrigger -Daily -At $At
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
  Register-ScheduledTask -TaskName "JourneyMap Atlas sync" -Action $action `
    -Trigger $trigger -Settings $settings -Description "Publish JourneyMap tiles to GitHub Pages" -Force | Out-Null
  Write-Host "Scheduled 'JourneyMap Atlas sync' daily at $At."
  Write-Host "Remove it later with: Unregister-ScheduledTask -TaskName 'JourneyMap Atlas sync'"
  exit 0
}

Need git  "Install it from https://git-scm.com/download/win"
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $python) { throw "python is not on PATH. Install it from https://www.python.org/downloads/" }

if (-not (Test-Path $JourneyMap)) { throw "JourneyMap folder not found: $JourneyMap" }

Push-Location $repo
try {
  # nbtlib is only needed to read waypoints; the map builds without it.
  & $python.Source -c "import nbtlib" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing nbtlib (needed to read waypoints)..."
    & $python.Source -m pip install --quiet --user nbtlib
  }

  git pull --quiet --rebase --autostash

  $buildArgs = @((Join-Path $PSScriptRoot "build.py"), "--journeymap", $JourneyMap, "--out", $repo)
  if ($World) { $buildArgs += @("--world", $World) }
  & $python.Source @buildArgs
  if ($LASTEXITCODE -ne 0) { throw "build.py failed" }

  if (-not (git status --porcelain)) {
    Write-Host "No map changes to publish."
    exit 0
  }

  git add -A
  git commit --quiet -m "Sync map $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
  git push --quiet
  Write-Host "Published. The site refreshes in a minute or two:"
  Write-Host "  https://alexlynn12.github.io/journeymap-atlas/"
}
finally {
  Pop-Location
}
