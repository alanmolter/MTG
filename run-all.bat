@echo off
setlocal enabledelayedexpansion

:: =============================================================================
::  MTG AI - PIPELINE MASTER COMPLETO (Windows CMD)
::  Uso: run-all.bat
::  Opcional: run-all.bat commander 200 100
::    Arg 1: formato (modern/commander/standard/legacy) - default: modern
::    Arg 2: iteracoes de treinamento                   - default: 100
::    Arg 3: limite de decks a importar                 - default: 50
:: =============================================================================

set "FORMAT=%~1"
set "ITERATIONS=%~2"
set "DECKS=%~3"

if "%FORMAT%"=="" set "FORMAT=modern"
if "%ITERATIONS%"=="" set "ITERATIONS=100"
if "%DECKS%"=="" set "DECKS=50"

set STEP=0
set ERRORS=0

echo.
echo ==============================================================
echo    MTG AI - PIPELINE MASTER COMPLETO
echo ==============================================================
echo.
echo   Formato:    %FORMAT%
echo   Iteracoes:  %ITERATIONS%
echo   Decks:      %DECKS%
echo   Inicio:     %DATE% %TIME%
echo.

:: ============================================================
:: PASSO 1: Pre-requisitos
:: ============================================================
set /a STEP+=1
echo --------------------------------------------------------------
echo   PASSO %STEP%: Verificando pre-requisitos
echo --------------------------------------------------------------

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo   [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   [OK] Node.js %%v

npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo   [ERRO] npm nao encontrado.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('npm --version') do echo   [OK] npm %%v

if not exist "package.json" (
    echo   [ERRO] Execute este script na raiz do projeto MTG
    pause
    exit /b 1
)
echo   [OK] package.json encontrado

if exist ".env" (
    echo   [OK] .env encontrado
) else (
    echo   [AVISO] .env nao encontrado - usando variaveis de ambiente do sistema
)

:: ============================================================
:: PASSO 2: Dependencias
:: ============================================================
set /a STEP+=1
echo.
echo --------------------------------------------------------------
echo   PASSO %STEP%: Instalando dependencias
echo --------------------------------------------------------------
call npm install --silent
if %errorlevel% neq 0 (
    echo   [AVISO] npm install falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Dependencias instaladas
)

:: ============================================================
:: PASSO 3: Schema do banco
:: ============================================================
set /a STEP+=1
echo.
echo --------------------------------------------------------------
echo   PASSO %STEP%: Sincronizando schema do banco de dados
echo --------------------------------------------------------------
call npm run db:push
if %errorlevel% neq 0 (
    echo   [AVISO] db:push falhou - banco pode estar desatualizado
    set /a ERRORS+=1
) else (
    echo   [OK] Schema sincronizado
)

:: ============================================================
:: PASSO 4: Sincronizacao Scryfall
:: ============================================================
set /a STEP+=1
echo.
echo --------------------------------------------------------------
echo   PASSO %STEP%: Sincronizando cartas do Scryfall (bulk oracle)
echo --------------------------------------------------------------
call npx tsx server/sync-bulk.ts
if %errorlevel% neq 0 (
    echo   [AVISO] sync-bulk falhou - usando dados existentes
    set /a ERRORS+=1
) else (
    echo   [OK] Cartas Scryfall sincronizadas
)

:: ============================================================
:: PASSO 5: Seed inicial
:: ============================================================
set /a STEP+=1
echo.
echo --------------------------------------------------------------
echo   PASSO %STEP%: Seed inicial de cartas (se necessario)
echo --------------------------------------------------------------
call npm run seed:scryfall
if %errorlevel% neq 0 (
    echo   [AVISO] Seed falhou ou ja foi executado anteriormente
    set /a ERRORS+=1
) else (
    echo   [OK] Seed concluido
)

:: ============================================================
:: PASSO 6: Importacao de decks competitivos
:: ============================================================
set /a STEP+=1
echo.
echo --------------------------------------------------------------
echo   PASSO %STEP%: Importando decks (MTGGoldfish + MTGTop8)
echo --------------------------------------------------------------
echo   Importando MTGGoldfish - formato: %FORMAT%, limite: %DECKS%...
call npx tsx import-and-train.ts
if %errorlevel% neq 0 (
    echo   [AVISO] import-and-train falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Importacao e embeddings concluidos
)

:: ============================================================
:: PASSO 7: Clustering de arquetipos
:: ============================================================
set /a STEP+=1
echo.
echo --------------------------------------------------------------
echo   PASSO %STEP%: Clustering de arquetipos (KMeans)
echo --------------------------------------------------------------
call npx tsx run-clustering.ts
if %errorlevel% neq 0 (
    echo   [AVISO] Clustering falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Clustering concluido
)

:: ============================================================
:: PASSO 8: Brain v2
:: ============================================================
set /a STEP+=1
echo.
echo --------------------------------------------------------------
echo   PASSO %STEP%: Treinamento do Brain v2
echo --------------------------------------------------------------
call npm run teach
if %errorlevel% neq 0 (
    echo   [AVISO] Brain training falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Brain v2 treinado
)

:: ============================================================
:: PASSO 9: Commander Specialist
:: ============================================================
set /a STEP+=1
echo.
echo --------------------------------------------------------------
echo   PASSO %STEP%: Treinamento especializado em Comandantes
echo --------------------------------------------------------------
call npx tsx server/scripts/trainCommander.ts
if %errorlevel% neq 0 (
    echo   [AVISO] Commander training falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Treinamento Commander concluido
)

:: ============================================================
:: PASSO 10: Self-Play continuo
:: ============================================================
set /a STEP+=1
echo.
echo --------------------------------------------------------------
echo   PASSO %STEP%: Loop de treinamento continuo (%ITERATIONS% iteracoes)
echo --------------------------------------------------------------
call npx tsx server/scripts/continuousTraining.ts
if %errorlevel% neq 0 (
    echo   [AVISO] Treinamento continuo falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Treinamento continuo concluido
)

:: ============================================================
:: PASSO 11: Verificar pesos
:: ============================================================
set /a STEP+=1
echo.
echo --------------------------------------------------------------
echo   PASSO %STEP%: Verificando pesos e aprendizado acumulado
echo --------------------------------------------------------------
call npm run check:learn
if %errorlevel% neq 0 (
    echo   [AVISO] check:learn falhou
    set /a ERRORS+=1
) else (
    echo   [OK] Pesos verificados
)

:: ============================================================
:: PASSO 12: Testes de regressao
:: ============================================================
set /a STEP+=1
echo.
echo --------------------------------------------------------------
echo   PASSO %STEP%: Testes de regressao do modelo
echo --------------------------------------------------------------
call npm run test:model
if %errorlevel% neq 0 (
    echo   [AVISO] Testes de modelo falharam
    set /a ERRORS+=1
) else (
    echo   [OK] Testes de modelo passaram
)

:: ============================================================
:: PASSO 13: Suite de testes vitest
:: ============================================================
set /a STEP+=1
echo.
echo --------------------------------------------------------------
echo   PASSO %STEP%: Suite de testes automatizados (vitest)
echo --------------------------------------------------------------
call npm test
if %errorlevel% neq 0 (
    echo   [AVISO] Alguns testes falharam
    set /a ERRORS+=1
) else (
    echo   [OK] Todos os testes passaram
)

:: ============================================================
:: RELATORIO FINAL
:: ============================================================
echo.
echo ==============================================================
echo   RELATORIO FINAL
echo ==============================================================
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
    echo ==============================================================
    echo    PIPELINE CONCLUIDO COM SUCESSO TOTAL
    echo ==============================================================
) else (
    echo ==============================================================
    echo    PIPELINE CONCLUIDO COM %ERRORS% AVISO(S) NAO-CRITICO(S)
    echo ==============================================================
)

echo.
pause
endlocal
