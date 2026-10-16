#Requires -Version 5.1
<#
.SYNOPSIS
    Collects sealed, pre-promotion Forge evaluations for one Ray checkpoint.

.DESCRIPTION
    Every game is recorded with the candidate checkpoint identity and does not
    alter card_learning. ForgeRLBridge currently uses Forge's internal AI for
    both sides, so these GUI games are deck-only evidence and are deliberately
    excluded from Ray policy promotion. This script must not be used to claim
    that a Ray checkpoint beat a baseline.

.EXAMPLE
    npm run forge:evaluate:10 -- -CandidateCheckpoint "C:\\...\\checkpoint_000123"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$CandidateCheckpoint,

    [ValidateRange(1, 100)]
    [int]$Count = 10,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $projectRoot 'package.json'))) {
    throw 'package.json não encontrado. Execute dentro do repositório do projeto.'
}
if (-not (Test-Path -LiteralPath $CandidateCheckpoint)) {
    throw "checkpoint não encontrado: $CandidateCheckpoint"
}

$resolvedCheckpoint = (Resolve-Path -LiteralPath $CandidateCheckpoint).Path
Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' Forge - avaliacao pre-promocao' -ForegroundColor Cyan
Write-Host " Candidato : $resolvedCheckpoint" -ForegroundColor White
Write-Host " Partidas  : $Count" -ForegroundColor White
Write-Host ' Pesos     : bloqueados; somente evidencia de deck sera registrada.' -ForegroundColor Yellow
Write-Host ' Promocao  : bloqueada para GUI ate o bridge executar a politica Ray.' -ForegroundColor Yellow
Write-Host '============================================================' -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[dry-run] npm run forge:evaluate -- --candidate-checkpoint `"$resolvedCheckpoint`"" -ForegroundColor Yellow
    exit 0
}

Push-Location $projectRoot
try {
    for ($index = 1; $index -le $Count; $index++) {
        Write-Host "`n--- Avaliacao $index/$Count ---" -ForegroundColor Cyan
        & npm run forge:evaluate -- --candidate-checkpoint $resolvedCheckpoint
        if ($LASTEXITCODE -ne 0) {
            throw "a partida $index falhou (exit $LASTEXITCODE); coleta interrompida sem aplicar pesos"
        }
    }
} finally {
    Pop-Location
}

Write-Host "`n$Count partidas registradas. Agora execute: npm run training:promote" -ForegroundColor Green
