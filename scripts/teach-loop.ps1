#Requires -Version 5.0
<#
.SYNOPSIS
    Roda `npm run teach` N vezes em sequência para drenar o A-bias
    legado via decay 3% por run.

.DESCRIPTION
    Cada execução de `npm run teach` aplica decay de 3% em todos os
    pesos (fator 0.97) antes do treino. Após N runs o peso saturado
    cai por 0.97^N:

        46 * 0.97^20 ≈ 24.9     (default: 20 runs → ~46% de decaimento)
        46 * 0.97^30 ≈ 18.4
        46 * 0.97^50 ≈ 10.1

    Isso volta a faixa saudável (20–30) onde o reality guard + LLM
    calibrator podem refinar sem self-reinforcement excessivo.

    Tempo esperado: ~11 min por run × 20 = ~3.7 horas no laptop do
    projeto (observado: 680s commander + self-play ≈ 11.3 min/run).

    Cada run é idempotente do ponto de vista do banco: Ctrl+C em
    qualquer momento e re-execução continuam de onde parou (os pesos
    persistidos refletem o estado atual).

.PARAMETER Count
    Número de runs sequenciais. Default 20.

.PARAMETER CheckBetween
    Se presente, executa `npm run check:learn` entre cada run. Útil
    para observar o drenar do A-bias em tempo real.

.PARAMETER StopOnFail
    Se presente, aborta o loop no primeiro run com exit != 0. Default
    é continuar e logar o aviso.

.EXAMPLE
    # default — 20 runs sem pausa
    .\scripts\teach-loop.ps1

    # 30 runs, ver check:learn entre cada
    .\scripts\teach-loop.ps1 -Count 30 -CheckBetween

    # via npm
    npm run teach:20
#>
param(
    [int]$Count = 20,
    [switch]$CheckBetween = $false,
    [switch]$StopOnFail = $false,
    # Quando presente, restringe os trainers ao pool MTG Arena (~3k Standard
    # / ~12k Pioneer + Historic) em vez do catálogo paper completo. Setamos
    # a env var antes do loop para que TODOS os subprocessos npm/tsx
    # herdem. Os trainers leem via server/scripts/utils/poolFilter.ts.
    [switch]$Arena = $false
)

$ErrorActionPreference = 'Continue'

# Verificação de sanidade: estamos na raiz do projeto?
if (-not (Test-Path "package.json")) {
    Write-Host "  [ERRO] package.json não encontrado. Rode da raiz do projeto." -ForegroundColor Red
    exit 1
}

if ($Arena) {
    $env:TRAINING_POOL_ARENA_ONLY = "1"
} else {
    # Limpar caso o usuário tenha setado por outro caminho — garantir que
    # `-Arena $false` realmente significa pool completo.
    Remove-Item Env:\TRAINING_POOL_ARENA_ONLY -ErrorAction SilentlyContinue
}

$start       = Get-Date
$failCount   = 0
$etaMinutes  = $Count * 11
$startedTag  = (Get-Date -Format 'HH:mm:ss')
$poolLabel   = if ($Arena) { 'Arena-only' } else { 'Catalogo completo' }

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  TEACH LOOP -- $Count runs sequenciais" -ForegroundColor Cyan
Write-Host "  Start : $startedTag   ETA: ~${etaMinutes} min" -ForegroundColor Cyan
Write-Host "  Pool  : $poolLabel" -ForegroundColor Cyan
Write-Host "  Decay : 0.97^$Count = $([math]::Round([math]::Pow(0.97, $Count), 3))  (peso 46 -> $([math]::Round(46 * [math]::Pow(0.97, $Count), 1)))" -ForegroundColor Cyan
Write-Host "  Check : $(if ($CheckBetween) { 'após cada run' } else { 'apenas ao final' })" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

for ($i = 1; $i -le $Count; $i++) {
    $runStart    = Get-Date
    $elapsedMin  = [math]::Round(((Get-Date) - $start).TotalMinutes, 1)

    Write-Host ""
    Write-Host "-----------------------------------------------------------" -ForegroundColor Yellow
    Write-Host " Run $i / $Count   elapsed ${elapsedMin}min   failures: $failCount" -ForegroundColor Yellow
    Write-Host "-----------------------------------------------------------" -ForegroundColor Yellow

    & npm run teach

    if ($LASTEXITCODE -ne 0) {
        $failCount++
        Write-Host "  [AVISO] Run $i retornou exit=$LASTEXITCODE" -ForegroundColor Yellow
        if ($StopOnFail) {
            Write-Host "  [ABORTADO] -StopOnFail ativo. Interrompendo loop." -ForegroundColor Red
            break
        }
    }

    $runMin = [math]::Round(((Get-Date) - $runStart).TotalMinutes, 1)
    Write-Host "  -> Run $i concluída em ${runMin}min" -ForegroundColor DarkGray

    if ($CheckBetween) {
        Write-Host ""
        Write-Host "  [check:learn após run $i]" -ForegroundColor DarkCyan
        & npm run check:learn
    }
}

$totalMin    = [math]::Round(((Get-Date) - $start).TotalMinutes, 1)
$successRuns = $Count - $failCount
$peakDecay   = [math]::Round((1 - [math]::Pow(0.97, $successRuns)) * 100, 1)

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  TEACH LOOP CONCLUIDO" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Runs totais        : $Count" -ForegroundColor White
Write-Host "  Runs com sucesso   : $successRuns" -ForegroundColor White
Write-Host "  Runs com falha     : $failCount" -ForegroundColor White
Write-Host "  Duracao total      : ${totalMin} min" -ForegroundColor White
Write-Host "  Decay acumulado    : ${peakDecay}% (peso 46 -> $([math]::Round(46 * [math]::Pow(0.97, $successRuns), 1)))" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Green

Write-Host ""
Write-Host "  Estado final (check:learn):" -ForegroundColor Cyan
Write-Host ""
& npm run check:learn
