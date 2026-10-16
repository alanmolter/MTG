#Requires -Version 5.1
<#
.SYNOPSIS
    Launches the Ray PBT trainer with an explicit, configurable time budget.

.EXAMPLE
    npm run train:ray:dual-gpu -- -BudgetHours 2

.EXAMPLE
    npm run train:ray:dual-gpu -- -BudgetHours 12 -Arena

.NOTES
    With the defaults, each of the two PBT trials reserves one complete GPU.
    Ctrl+C requests a graceful stop from Ray; checkpoints created before the
    interruption remain available in the Ray results directory.
#>
[CmdletBinding()]
param(
    [ValidateRange(0.01, 168.0)]
    [double]$BudgetHours = 24.0,

    [ValidateRange(1, 64)]
    [int]$NumWorkers = 2,

    [ValidateRange(1, 2)]
    [int]$NumTrials = 2,

    [ValidateRange(50, 1000000)]
    [int]$BatchSize = 500,

    [ValidateRange(1, 10000)]
    [int]$CheckpointFreq = 10,

    [ValidateRange(1, 100000)]
    [int]$PerturbationInterval = 20,

    [switch]$Arena,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path (Join-Path $projectRoot 'package.json'))) {
    throw 'package.json não encontrado. Execute a partir do repositório do projeto.'
}

$commandArgs = @(
    'scripts/run-python.mjs', '-m', 'ml_engine.ray_cluster.orchestrator',
    '--num-workers', $NumWorkers,
    '--num-trials', $NumTrials,
    '--budget-hours', $BudgetHours,
    '--batch-size', $BatchSize,
    '--checkpoint-freq', $CheckpointFreq,
    '--perturbation-interval', $PerturbationInterval
)
if ($Arena) { $commandArgs += '--arena-only' }

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' MTG Ray PBT - treino dual GPU' -ForegroundColor Cyan
Write-Host " Duracao maxima : $BudgetHours hora(s)" -ForegroundColor White
Write-Host " Trials / GPUs  : $NumTrials / 1 GPU por trial" -ForegroundColor White
Write-Host " Env workers    : $NumWorkers por trial" -ForegroundColor White
Write-Host " Checkpoint     : a cada $CheckpointFreq iteracoes" -ForegroundColor White
Write-Host " Pool           : $(if ($Arena) { 'Arena' } else { 'completo' })" -ForegroundColor White
Write-Host ' Ctrl+C encerra o treino; checkpoints ja gravados sao preservados.' -ForegroundColor DarkGray
Write-Host '============================================================' -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[dry-run] node $($commandArgs -join ' ')" -ForegroundColor Yellow
    exit 0
}

# A reserva inteira elimina disputa de VRAM: dois trials, duas GPUs visíveis.
$previousGpuPerTrial = $env:MTG_GPU_PER_TRIAL
$previousArenaOnly = $env:TRAINING_POOL_ARENA_ONLY
try {
    $env:MTG_GPU_PER_TRIAL = '1'
    if ($Arena) {
        $env:TRAINING_POOL_ARENA_ONLY = '1'
    } else {
        Remove-Item Env:TRAINING_POOL_ARENA_ONLY -ErrorAction SilentlyContinue
    }

    Push-Location $projectRoot
    try {
        Write-Host '[preflight] verificando Forge, mascara de acoes e GPUs...' -ForegroundColor Cyan
        & node scripts/run-python.mjs -m ml_engine.scripts.training_preflight --min-gpus $NumTrials
        if ($LASTEXITCODE -ne 0) {
            throw "Preflight do treino falhou (codigo $LASTEXITCODE). Corrija o gate antes de consumir horas de GPU."
        }
        Write-Host '[mecanicas] exercitando ataques, bloqueios, alvos e habilidades ativadas no Forge...' -ForegroundColor Cyan
        & node scripts/run-python.mjs -m ml_engine.scripts.mechanics_gate
        if ($LASTEXITCODE -ne 0) {
            throw "Gate de mecanicas falhou (codigo $LASTEXITCODE). Treino cancelado antes de consumir horas de GPU."
        }
        & node @commandArgs
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $previousGpuPerTrial) { Remove-Item Env:MTG_GPU_PER_TRIAL -ErrorAction SilentlyContinue }
    else { $env:MTG_GPU_PER_TRIAL = $previousGpuPerTrial }
    if ($null -eq $previousArenaOnly) { Remove-Item Env:TRAINING_POOL_ARENA_ONLY -ErrorAction SilentlyContinue }
    else { $env:TRAINING_POOL_ARENA_ONLY = $previousArenaOnly }
}

exit $exitCode
