#Requires -Version 5.0
<#
.SYNOPSIS
    MTG AI - Pipeline Completo (PowerShell nativo)

.DESCRIPTION
    Executa todas as 12 etapas do pipeline de treinamento da IA MTG.
    Funciona diretamente no PowerShell sem precisar do prefixo .\

.USAGE
    # Opção 1 — Diretamente no PowerShell (recomendado):
    .\run-all.ps1

    # Opção 2 — Com parâmetros:
    .\run-all.ps1 -Format commander -Iterations 200 -Decks 100

    # Opção 3 — Se der erro de ExecutionPolicy:
    powershell -ExecutionPolicy Bypass -File .\run-all.ps1

.NOTES
    Para não precisar do .\ , execute uma vez no PowerShell:
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
#>

param(
    [string]$Format     = "modern",
    [int]   $Iterations = 100,
    [int]   $Decks      = 50
)

# ─── Cores e helpers ──────────────────────────────────────────────────────────
$ESC = [char]27
function Write-Header {
    Write-Host ""
    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-Host "     MTG AI - PIPELINE MASTER COMPLETO (PowerShell)" -ForegroundColor Cyan
    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-Host "     Formato   : $Format" -ForegroundColor White
    Write-Host "     Iteracoes : $Iterations" -ForegroundColor White
    Write-Host "     Decks     : $Decks" -ForegroundColor White
    Write-Host "     Inicio    : $(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')" -ForegroundColor White
    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step {
    param([string]$Step, [string]$Label)
    Write-Host ""
    Write-Host "  [$Step] $Label" -ForegroundColor Yellow
    Write-Host "  $('-' * 54)" -ForegroundColor DarkGray
}

function Write-OK   { Write-Host "     OK" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "     [AVISO] $msg" -ForegroundColor DarkYellow }
function Write-Fail { param([string]$msg) Write-Host "     [ERRO] $msg" -ForegroundColor Red }

function Run-Step {
    param([string]$Cmd, [string]$Args = "")
    if ($Args) {
        & $Cmd $Args.Split(" ")
    } else {
        & $Cmd
    }
    return $LASTEXITCODE
}

# ─── Início ───────────────────────────────────────────────────────────────────
$errors = 0
Write-Header

# ─── Passo 1: Pré-requisitos ──────────────────────────────────────────────────
Write-Step "1/12" "Verificando pre-requisitos..."
try {
    $nodeVer = node --version 2>&1
    Write-Host "     Node.js $nodeVer OK" -ForegroundColor Green
} catch {
    Write-Fail "Node.js nao encontrado. Instale em https://nodejs.org"
    exit 1
}
if (-not (Test-Path "package.json")) {
    Write-Fail "Execute na raiz do projeto MTG (onde esta o package.json)"
    exit 1
}
Write-Host "     package.json OK" -ForegroundColor Green

# ─── Passo 2: Dependências ────────────────────────────────────────────────────
Write-Step "2/12" "Verificando dependencias (npm install)..."
Write-Host "     Aguarde, isso pode levar 1-2 minutos na primeira vez..." -ForegroundColor DarkGray
npm install --legacy-peer-deps --silent 2>&1 | Out-Null
Write-OK

# ─── Passo 3: Migrations ──────────────────────────────────────────────────────
Write-Step "3/12" "Verificando schema do banco de dados..."
Write-Host "     Aguarde..." -ForegroundColor DarkGray
npx tsx server/scripts/applyMigration.ts
if ($LASTEXITCODE -ne 0) { Write-Warn "applyMigration retornou erro"; $errors++ }

# ─── Passo 4: Sync Scryfall ───────────────────────────────────────────────────
Write-Step "4/12" "Sincronizando cartas do Scryfall (bulk oracle)..."
Write-Host "     Verificando se banco precisa de atualizacao..." -ForegroundColor DarkGray
npx tsx server/sync-bulk.ts
if ($LASTEXITCODE -ne 0) { Write-Warn "sync-bulk falhou - usando dados existentes"; $errors++ }

# ─── Passo 5: Importar decks ──────────────────────────────────────────────────
Write-Step "5/12" "Importando decks competitivos (MTGGoldfish + MTGTop8)..."
Write-Host "     Aguarde - conectando aos sites (pode levar 8-10 min para 120 decks)..." -ForegroundColor DarkGray
Write-Host "     Formatos: standard, modern, legacy, pioneer, pauper, vintage" -ForegroundColor DarkGray
npx tsx import-and-train.ts
if ($LASTEXITCODE -ne 0) { Write-Warn "import-and-train falhou"; $errors++ }

# ─── Passo 6: Clustering ──────────────────────────────────────────────────────
Write-Step "6/12" "Clustering de arquetipos (KMeans)..."
Write-Host "     Aguarde - analisando decks no banco..." -ForegroundColor DarkGray
npx tsx run-clustering.ts
if ($LASTEXITCODE -ne 0) { Write-Warn "Clustering falhou"; $errors++ }

# ─── Passo 7: Brain v2 ────────────────────────────────────────────────────────
Write-Step "7/12" "Treinando Brain v2 (avaliacao de decks)..."
Write-Host "     Aguarde - este passo pode levar varios minutos..." -ForegroundColor DarkGray
npm run teach
if ($LASTEXITCODE -ne 0) { Write-Warn "Brain v2 training falhou"; $errors++ }

# ─── Passo 8: Commander ───────────────────────────────────────────────────────
Write-Step "8/12" "Treinando especialista Commander (300 iteracoes)..."
Write-Host "     Aguarde - barra de progresso aparecera em instantes..." -ForegroundColor DarkGray
npx tsx server/scripts/trainCommander.ts
if ($LASTEXITCODE -ne 0) { Write-Warn "Commander training falhou"; $errors++ }

# ─── Passo 9: Self-Play ───────────────────────────────────────────────────────
Write-Step "9/12" "Self-Play Loop ($Iterations iteracoes)..."
Write-Host "     Aguarde - barra de progresso aparecera em instantes..." -ForegroundColor DarkGray
npx tsx server/scripts/continuousTraining.ts
if ($LASTEXITCODE -ne 0) { Write-Warn "continuousTraining falhou"; $errors++ }

# ─── Passo 10: Verificar pesos ────────────────────────────────────────────────
Write-Step "10/12" "Verificando pesos aprendidos..."
npm run check:learn
if ($LASTEXITCODE -ne 0) { Write-Warn "check:learn falhou"; $errors++ }

# ─── Passo 11: Testes de regressão ────────────────────────────────────────────
Write-Step "11/12" "Testes de regressao do modelo..."
npm run test:model
if ($LASTEXITCODE -ne 0) { Write-Warn "Testes de modelo falharam"; $errors++ }

# ─── Passo 12: Vitest ─────────────────────────────────────────────────────────
Write-Step "12/12" "Suite de testes vitest..."
npm test
if ($LASTEXITCODE -ne 0) { Write-Warn "Alguns testes vitest falharam"; $errors++ }

# ─── Relatório Final ──────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "     RELATORIO FINAL" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "     Passos  : 12" -ForegroundColor White
if ($errors -eq 0) {
    Write-Host "     Avisos  : 0 (tudo OK!)" -ForegroundColor Green
} else {
    Write-Host "     Avisos  : $errors" -ForegroundColor DarkYellow
}
Write-Host "     Termino : $(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')" -ForegroundColor White
Write-Host ""
Write-Host "     Proximos passos:" -ForegroundColor White
Write-Host "       1. Inicie o servidor : npm run dev" -ForegroundColor DarkGray
Write-Host "       2. Acesse            : http://localhost:3000" -ForegroundColor DarkGray
Write-Host "       3. Repita o pipeline : .\run-all.ps1" -ForegroundColor DarkGray
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""
