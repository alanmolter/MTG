#Requires -Version 5.0
<#
.SYNOPSIS
    Identify (and optionally purge) PBT experiments with permanently dead trials.

.DESCRIPTION
    PBT explores by copying checkpoints between trials. The pbt_policy_*.txt
    state files store ABSOLUTE paths to those checkpoints. If you ever
    interrupt a run and resume it with a different RAY_RESULTS_DIR (e.g.
    moved from OneDrive to LOCALAPPDATA), the policy still references the
    old path and PBT cannot exploit -> the trial dies with:

        ValueError: Could not recover from checkpoint as it does not exist
        on storage anymore. Got storage fs type `local` and path: <OLD_PATH>

    After max_failures exploit attempts, that trial is marked DEAD for
    the rest of the run. tune.run continues with the survivors, but you've
    lost 1/N of your population.

    This script:
      1. Scans $env:LOCALAPPDATA\mtg-deck-mvp\ray_results\pbt_*\
      2. Inside each, looks at every trial dir for error.txt
      3. Reports trials with the "Could not recover from checkpoint" pattern
         (stale-path failures) and trials with other crash modes
      4. With -Apply, deletes the entire experiment dir for the stale-path
         experiments (so the next train.ps1 starts cleanly without inheriting
         the broken policy state)

    Without -Apply this is a dry run. Always inspect output first.

.USAGE
    .\scripts\purge-stale-pbt.ps1               # report only
    .\scripts\purge-stale-pbt.ps1 -Apply        # delete stale experiments
    .\scripts\purge-stale-pbt.ps1 -RayResults D:\custom\ray_results -Apply

.NOTES
    Runs from anywhere. Defaults to the LOCALAPPDATA path used by train.ps1.
#>
param(
    [string]$RayResults = (Join-Path $env:LOCALAPPDATA "mtg-deck-mvp\ray_results"),
    [switch]$Apply = $false
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $RayResults)) {
    Write-Host "  No ray_results dir at $RayResults -- nothing to do." -ForegroundColor DarkGray
    exit 0
}

Write-Host ""
Write-Host "  Scanning $RayResults..." -ForegroundColor Cyan

$stale  = New-Object System.Collections.Generic.List[string]
$other  = New-Object System.Collections.Generic.List[string]
$clean  = New-Object System.Collections.Generic.List[string]

$experiments = Get-ChildItem $RayResults -Directory -Filter "pbt_*" -ErrorAction SilentlyContinue
foreach ($exp in $experiments) {
    $errFiles = Get-ChildItem $exp.FullName -Recurse -Filter "error.txt" -ErrorAction SilentlyContinue
    if (-not $errFiles) { $clean.Add($exp.Name) | Out-Null; continue }

    $hasStale = $false
    $hasOther = $false
    foreach ($ef in $errFiles) {
        $txt = Get-Content -Raw -LiteralPath $ef.FullName -ErrorAction SilentlyContinue
        if ($txt -match 'Could not recover from checkpoint as it does not exist on storage') {
            $hasStale = $true
        } else {
            $hasOther = $true
        }
    }

    if ($hasStale) { $stale.Add($exp.Name) | Out-Null }
    elseif ($hasOther) { $other.Add($exp.Name) | Out-Null }
    else { $clean.Add($exp.Name) | Out-Null }
}

Write-Host ""
Write-Host "  Clean experiments        : $($clean.Count)" -ForegroundColor Green
Write-Host "  Other-crash experiments  : $($other.Count)" -ForegroundColor Yellow
Write-Host "  Stale-checkpoint experiments: $($stale.Count)" -ForegroundColor Red

if ($other.Count -gt 0) {
    Write-Host ""
    Write-Host "  Experiments with non-stale crashes (kept -- investigate manually):" -ForegroundColor Yellow
    foreach ($n in $other) { Write-Host "    - $n" -ForegroundColor Yellow }
}

if ($stale.Count -eq 0) {
    Write-Host ""
    Write-Host "  Nothing to purge." -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "  Stale-checkpoint experiments (PBT cannot recover these):" -ForegroundColor Red
foreach ($n in $stale) {
    $size = (Get-ChildItem (Join-Path $RayResults $n) -Recurse -ErrorAction SilentlyContinue |
             Measure-Object -Property Length -Sum).Sum
    $mb = if ($size) { [math]::Round($size / 1MB, 1) } else { 0 }
    Write-Host ("    - {0,-40} ({1} MB)" -f $n, $mb) -ForegroundColor Red
}

if (-not $Apply) {
    Write-Host ""
    Write-Host "  Dry run. Re-run with -Apply to delete the stale experiments." -ForegroundColor DarkGray
    exit 0
}

Write-Host ""
Write-Host "  Deleting stale experiments..." -ForegroundColor Yellow
foreach ($n in $stale) {
    $p = Join-Path $RayResults $n
    try {
        Remove-Item $p -Recurse -Force -ErrorAction Stop
        Write-Host "    deleted: $n" -ForegroundColor Green
    } catch {
        Write-Host "    FAILED:  $n -> $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "  Done. Next train.ps1 will start a fresh experiment." -ForegroundColor Green
