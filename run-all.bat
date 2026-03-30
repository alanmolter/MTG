@echo off
setlocal EnableDelayedExpansion

:: MTG AI - Pipeline Completo (Windows CMD)
:: Uso: run-all.bat [formato] [iteracoes] [decks]
:: Exemplo: run-all.bat commander 200 100

set ARG1=%~1
set ARG2=%~2
set ARG3=%~3

if "%ARG1%"=="" (set FORMAT=modern) else (set FORMAT=%ARG1%)
if "%ARG2%"=="" (set ITERATIONS=100) else (set ITERATIONS=%ARG2%)
if "%ARG3%"=="" (set DECKS=50) else (set DECKS=%ARG3%)

set ERRORS=0

echo.
echo ==============================================================
echo    MTG AI - PIPELINE MASTER COMPLETO
echo ==============================================================
echo    Formato:   %FORMAT%
echo    Iteracoes: %ITERATIONS%
echo    Decks:     %DECKS%
echo    Inicio:    %DATE% %TIME%
echo ==============================================================
echo.

:: --- PASSO 1: Pre-requisitos ---
echo [1/12] Verificando pre-requisitos...
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo    Node.js %%v OK
if not exist "package.json" (
    echo [ERRO] Execute na raiz do projeto MTG
    pause
    exit /b 1
)
echo    package.json OK

:: --- PASSO 2: Dependencias ---
echo.
echo [2/12] Instalando dependencias...
call npm install --prefer-offline --silent 2>nul
if errorlevel 1 (
    call npm install --silent 2>nul
    if errorlevel 1 (
        echo [AVISO] npm install retornou erro - continuando com modulos existentes
        set /a ERRORS=ERRORS+1
    ) else (
        echo    OK
    )
) else (
    echo    OK
)

:: --- PASSO 3: Migracoes do banco ---
echo.
echo [3/12] Aplicando migracoes do banco de dados...
call npx tsx server/scripts/applyMigration.ts
if errorlevel 1 (
    echo [AVISO] applyMigration retornou erro
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 4: Sync Scryfall (bulk oracle) ---
echo.
echo [4/12] Sincronizando cartas do Scryfall (bulk oracle)...
echo    Este passo pode demorar alguns minutos na primeira vez.
call npx tsx server/sync-bulk.ts
if errorlevel 1 (
    echo [AVISO] sync-bulk falhou - usando dados existentes
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 5: Importar decks MTGGoldfish + MTGTop8 ---
echo.
echo [5/12] Importando decks do MTGGoldfish e MTGTop8...
call npx tsx import-and-train.ts
if errorlevel 1 (
    echo [AVISO] import-and-train falhou
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 6: Clustering ---
echo.
echo [6/12] Clustering de arquetipos (KMeans)...
call npx tsx run-clustering.ts
if errorlevel 1 (
    echo [AVISO] Clustering falhou
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 7: Brain v2 ---
echo.
echo [7/12] Treinando Brain v2...
call npm run teach
if errorlevel 1 (
    echo [AVISO] Brain v2 training falhou
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 8: Commander Specialist ---
echo.
echo [8/12] Treinando especialista Commander...
call npx tsx server/scripts/trainCommander.ts
if errorlevel 1 (
    echo [AVISO] Commander training falhou
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 9: Self-Play continuo ---
echo.
echo [9/12] Self-Play Loop (%ITERATIONS% iteracoes)...
call npx tsx server/scripts/continuousTraining.ts
if errorlevel 1 (
    echo [AVISO] continuousTraining falhou
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 10: Verificar pesos ---
echo.
echo [10/12] Verificando pesos aprendidos...
call npm run check:learn
if errorlevel 1 (
    echo [AVISO] check:learn falhou
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 11: Testes de regressao ---
echo.
echo [11/12] Testes de regressao do modelo...
call npm run test:model
if errorlevel 1 (
    echo [AVISO] Testes de modelo falharam
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 12: Suite vitest ---
echo.
echo [12/12] Suite de testes vitest...
call npm test
if errorlevel 1 (
    echo [AVISO] Alguns testes vitest falharam
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- Relatorio Final ---
echo.
echo ==============================================================
echo    RELATORIO FINAL
echo    Passos: 12   Avisos: %ERRORS%
echo    Termino: %DATE% %TIME%
echo.
echo    Proximos passos:
echo      1. Inicie o servidor: npm run dev
echo      2. Acesse: http://localhost:3000
echo      3. Repita run-all.bat para treinar mais
echo ==============================================================
echo.

pause
endlocal
