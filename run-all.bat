@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: =============================================================================
::  MTG AI — PIPELINE MASTER COMPLETO (Windows)
::  Uso: run-all.bat
::  Opcional: run-all.bat commander 200 100
::    Arg 1: formato (modern/commander/standard/legacy) — default: modern
::    Arg 2: iteracoes de treinamento                  — default: 100
::    Arg 3: limite de decks a importar                — default: 50
:: =============================================================================

set FORMAT=%~1
set ITERATIONS=%~2
set DECKS=%~3

if "%FORMAT%"==""     set FORMAT=modern
if "%ITERATIONS%"=""  set ITERATIONS=100
if "%DECKS%"==""      set DECKS=50

set STEP=0
set ERRORS=0

echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║           🧙 MTG AI — PIPELINE MASTER COMPLETO 🧙           ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.
echo   Formato:    %FORMAT%
echo   Iteracoes:  %ITERATIONS%
echo   Decks:      %DECKS%
echo   Inicio:     %DATE% %TIME%
echo.

:: ── PASSO 1: Pré-requisitos ──────────────────────────────────────────────────
set /a STEP+=1
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Verificando pre-requisitos
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

node --version >nul 2>&1
if errorlevel 1 (
    echo   [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
    exit /b 1
) else (
    for /f "tokens=*" %%v in ('node --version') do echo   [OK] Node.js %%v
)

npm --version >nul 2>&1
if errorlevel 1 (
    echo   [ERRO] npm nao encontrado.
    exit /b 1
) else (
    for /f "tokens=*" %%v in ('npm --version') do echo   [OK] npm %%v
)

if not exist "package.json" (
    echo   [ERRO] Execute este script na raiz do projeto MTG
    exit /b 1
) else (
    echo   [OK] package.json encontrado
)

if exist ".env" (
    echo   [OK] .env encontrado
) else (
    echo   [AVISO] .env nao encontrado — usando variaveis de ambiente do sistema
)

:: ── PASSO 2: Dependências ────────────────────────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Instalando dependencias
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm install --silent
if errorlevel 1 (
    echo   [AVISO] npm install falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Dependencias instaladas
)

:: ── PASSO 3: Schema do banco ─────────────────────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Sincronizando schema do banco de dados
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run db:push
if errorlevel 1 (
    echo   [AVISO] db:push falhou — banco pode estar desatualizado
    set /a ERRORS+=1
) else (
    echo   [OK] Schema sincronizado
)

:: ── PASSO 4: Sincronização Scryfall ──────────────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Sincronizando cartas do Scryfall (bulk oracle)
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npx tsx server/sync-bulk.ts
if errorlevel 1 (
    echo   [AVISO] sync-bulk falhou — usando dados existentes
    set /a ERRORS+=1
) else (
    echo   [OK] Cartas Scryfall sincronizadas
)

:: ── PASSO 5: Seed inicial ────────────────────────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Seed inicial de cartas (se necessario)
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run seed:scryfall
if errorlevel 1 (
    echo   [AVISO] Seed falhou ou ja foi executado anteriormente
    set /a ERRORS+=1
) else (
    echo   [OK] Seed concluido
)

:: ── PASSO 6: Importação de decks competitivos ─────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Importando decks competitivos (MTGGoldfish + MTGTop8)
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   Importando MTGGoldfish — formato: %FORMAT%, limite: %DECKS%...
npx tsx -e "import('dotenv/config').then(()=>import('./server/services/mtggoldfishScraper.ts').then(m=>m.importMTGGoldfishDecks('%FORMAT%',%DECKS%).then(r=>console.log('[OK] Goldfish:',r.decksImported,'importados,',r.decksSkipped,'pulados')).catch(e=>console.warn('[AVISO] Goldfish:',e.message))))"
echo   Importando MTGTop8 — formato: %FORMAT%, limite: %DECKS%...
npx tsx -e "import('dotenv/config').then(()=>import('./server/services/mtgtop8Scraper.ts').then(m=>m.importMTGTop8Decks('%FORMAT%',%DECKS%).then(r=>console.log('[OK] Top8:',r.decksImported,'importados,',r.decksSkipped,'pulados')).catch(e=>console.warn('[AVISO] Top8:',e.message))))"

:: ── PASSO 7: Importação + Embeddings ─────────────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Importacao combinada + Embeddings Word2Vec
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npx tsx import-and-train.ts
if errorlevel 1 (
    echo   [AVISO] import-and-train falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Embeddings treinados
)

:: ── PASSO 8: Clustering ───────────────────────────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Clustering de arquetipos (KMeans)
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npx tsx run-clustering.ts
if errorlevel 1 (
    echo   [AVISO] Clustering falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Clustering concluido
)

:: ── PASSO 9: Brain v2 ─────────────────────────────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Treinamento do Brain v2
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run teach
if errorlevel 1 (
    echo   [AVISO] Brain training falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Brain v2 treinado
)

:: ── PASSO 10: Commander Specialist ───────────────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Treinamento especializado em Comandantes
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npx tsx server/scripts/trainCommander.ts
if errorlevel 1 (
    echo   [AVISO] Commander training falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Treinamento Commander concluido
)

:: ── PASSO 11: Self-Play contínuo ─────────────────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Loop de treinamento continuo (%ITERATIONS% iteracoes)
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npx tsx -e "import('dotenv/config').then(()=>import('./server/scripts/continuousTraining.ts').then(m=>(m.default||m.runContinuousTraining)(%ITERATIONS%)).catch(e=>{console.warn('[AVISO]',e.message);process.exit(0)}))"
if errorlevel 1 (
    echo   [AVISO] Treinamento continuo falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Treinamento continuo concluido
)

:: ── PASSO 12: Verificar pesos ────────────────────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Verificando pesos e aprendizado acumulado
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run check:learn
if errorlevel 1 (
    echo   [AVISO] check:learn falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Pesos verificados
)

:: ── PASSO 13: Testes de regressão ────────────────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Testes de regressao do modelo
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm run test:model
if errorlevel 1 (
    echo   [AVISO] Testes de modelo falharam
    set /a ERRORS+=1
) else (
    echo   [OK] Testes de modelo passaram
)

:: ── PASSO 14: Suite de testes ────────────────────────────────────────────────
set /a STEP+=1
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   PASSO %STEP%: Suite de testes automatizados (vitest)
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm test
if errorlevel 1 (
    echo   [AVISO] Alguns testes falharam
    set /a ERRORS+=1
) else (
    echo   [OK] Todos os testes passaram
)

:: ── Relatório final ───────────────────────────────────────────────────────────
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   RELATORIO FINAL
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   Passos executados: %STEP%
echo   Avisos:            %ERRORS%
echo   Termino:           %DATE% %TIME%
echo.
echo   Proximos passos:
echo     1. Inicie o servidor:  npm run dev
echo     2. Acesse o dashboard: http://localhost:3000
echo     3. Repita run-all.bat para tornar a IA mais inteligente
echo.

if %ERRORS%==0 (
    echo ╔══════════════════════════════════════════════════════════════╗
    echo ║          ✅  PIPELINE CONCLUIDO COM SUCESSO TOTAL  ✅        ║
    echo ╚══════════════════════════════════════════════════════════════╝
) else (
    echo ╔══════════════════════════════════════════════════════════════╗
    echo ║     ⚠️  PIPELINE CONCLUIDO COM %ERRORS% AVISO(S) NAO-CRITICO(S)    ║
    echo ╚══════════════════════════════════════════════════════════════╝
)
echo.
endlocal
