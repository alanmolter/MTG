#Requires -Version 5.0
<#
.SYNOPSIS
    MTG AI - Training Launcher (PowerShell 5.1 safe).

.DESCRIPTION
    Runs the Ray RLlib + PBT orchestrator in foreground with clean output.
    Uses the .venv Python directly so you don't need to worry about activating
    the virtual env in PowerShell (activate.ps1 is blocked by ExecutionPolicy
    by default on Windows - we bypass the whole problem by not activating).

    Loads .env into $env:* so DATABASE_URL etc. are visible to the Python
    worker processes (PowerShell doesn't auto-load .env like bash dotenv).

.USAGE
    # First time - with ExecutionPolicy bypass:
    powershell -ExecutionPolicy Bypass -File .\train.ps1

    # After:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
    .\train.ps1

    # Options:
    .\train.ps1 -NumWorkers 4 -NumTrials 6 -BudgetHours 12
    .\train.ps1 -BatchSize 512 -CheckpointFreq 10
    .\train.ps1 -Resume   # continue from latest checkpoint (if any)

.NOTES
    The legacy TypeScript training pipeline (run-all.ps1) is DIFFERENT from
    this Ray-based training. Use run-all.ps1 for the deck-evaluation brain +
    synergy learning pipeline; use this for the Pillar 1/6/7 game-play RL
    agent. Both can run; they update different tables.
#>
param(
    [int]$NumWorkers           = 2,
    [int]$NumTrials            = 4,
    [double]$BudgetHours       = 8.0,
    # BatchSize MUST be a multiple of RolloutFragmentLength. The orchestrator
    # auto-bumps misaligned values, but keeping the default aligned avoids the
    # warning. Default 500 = 10 × 50 (safe, produces 4 grad steps per trial iter).
    [int]$BatchSize            = 500,
    [int]$RolloutFragmentLength = 50,
    # MaxCards caps the obs-space card count. Lower = less RAM per worker.
    # 64 fits comfortably in 16GB RAM when running 4 trials × 4 workers.
    [int]$MaxCards             = 64,
    [int]$CheckpointFreq       = 5,
    [int]$PerturbationInterval = 10,
    [switch]$Resume            = $false,
    [string]$EnvFile           = ".env"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "     MTG AI - Ray RLlib + PBT Training" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "     Workers           : $NumWorkers" -ForegroundColor White
Write-Host "     Trials            : $NumTrials" -ForegroundColor White
Write-Host "     Budget            : $BudgetHours hours" -ForegroundColor White
Write-Host "     Batch size        : $BatchSize  (rollout fragment: $RolloutFragmentLength)" -ForegroundColor White
Write-Host "     Max cards in obs  : $MaxCards" -ForegroundColor White
Write-Host "     Checkpoint freq   : $CheckpointFreq iters" -ForegroundColor White
Write-Host "     PBT perturbation  : every $PerturbationInterval iters" -ForegroundColor White
Write-Host "     Resume            : $Resume" -ForegroundColor White

# --- Preflight: batch-size alignment ----------------------------------------
if ($BatchSize % $RolloutFragmentLength -ne 0) {
    $aligned = ([math]::Ceiling($BatchSize / $RolloutFragmentLength) * $RolloutFragmentLength)
    Write-Host ""
    Write-Host "  WARN: BatchSize $BatchSize is not a multiple of RolloutFragmentLength $RolloutFragmentLength." -ForegroundColor Yellow
    Write-Host "        This would crash IMPALA's _make_time_major with 'shape [B,T] invalid for input of N'." -ForegroundColor Yellow
    Write-Host "        Bumping to $aligned. See TRAINING_TROUBLESHOOTING.md." -ForegroundColor Yellow
    $BatchSize = $aligned
}
Write-Host "  ============================================================" -ForegroundColor Cyan

# --- Preflight ---------------------------------------------------------------
$pyExe = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $pyExe)) {
    Write-Host "FATAL: $pyExe missing. Run .\setup.ps1 first." -ForegroundColor Red
    exit 1
}
Write-Host "  using python: $pyExe" -ForegroundColor DarkGray

# --- Load .env ---------------------------------------------------------------
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        if ($line -match "^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$") {
            $v = $matches[2].Trim()
            if ($v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) }
            if ($v.StartsWith("'") -and $v.EndsWith("'")) { $v = $v.Substring(1, $v.Length - 2) }
            Set-Item -Path "env:$($matches[1])" -Value $v
        }
    }
    Write-Host "  .env loaded" -ForegroundColor DarkGray
} else {
    Write-Host "  WARN: no .env found - Python workers will inherit only current session env" -ForegroundColor Yellow
}

# --- Build argv for orchestrator --------------------------------------------
$cliArgs = @(
    "-m", "ml_engine.ray_cluster.orchestrator",
    "--num-workers", $NumWorkers,
    "--num-trials", $NumTrials,
    "--budget-hours", $BudgetHours,
    "--batch-size", $BatchSize,
    "--rollout-fragment-length", $RolloutFragmentLength,
    "--max-cards", $MaxCards,
    "--checkpoint-freq", $CheckpointFreq,
    "--perturbation-interval", $PerturbationInterval
)
if ($Resume) { $cliArgs += "--resume" }

Write-Host ""
Write-Host "  launching: $pyExe $($cliArgs -join ' ')" -ForegroundColor DarkGray
Write-Host "  press Ctrl+C to stop (Ray cleans up its workers)" -ForegroundColor DarkGray
Write-Host ""

# --- Foreground exec ---------------------------------------------------------
# We use & so Ctrl+C propagates to the Python child cleanly. Ray's SIGINT
# handler will then stop the trial workers on its own.
& $pyExe @cliArgs
$exit = $LASTEXITCODE

Write-Host ""
if ($exit -eq 0) {
    Write-Host "  training finished cleanly." -ForegroundColor Green
} else {
    Write-Host "  training exited with code $exit" -ForegroundColor Yellow
}
exit $exit
