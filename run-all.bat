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
echo [1/13] Verificando pre-requisitos...
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
echo [2/13] Instalando dependencias...
call npm install --silent
if errorlevel 1 (
    echo [AVISO] npm install retornou erro
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 3: Schema do banco ---
echo.
echo [3/13] Sincronizando schema do banco de dados...
call npm run db:push
if errorlevel 1 (
    echo [AVISO] db:push falhou - verifique DATABASE_URL no .env
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 4: Sync Scryfall ---
echo.
echo [4/13] Sincronizando cartas do Scryfall...
call npx tsx server/sync-bulk.ts
if errorlevel 1 (
    echo [AVISO] sync-bulk falhou - usando dados existentes
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 5: Seed inicial ---
echo.
echo [5/13] Seed inicial de cartas...
call npm run seed:scryfall
if errorlevel 1 (
    echo [AVISO] Seed falhou ou banco ja populado
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 6: Importar decks MTGGoldfish + MTGTop8 ---
echo.
echo [6/13] Importando decks do MTGGoldfish e MTGTop8...
call npx tsx import-and-train.ts
if errorlevel 1 (
    echo [AVISO] import-and-train falhou
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 7: Clustering ---
echo.
echo [7/13] Clustering de arquetipos (KMeans)...
call npx tsx run-clustering.ts
if errorlevel 1 (
    echo [AVISO] Clustering falhou
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 8: Brain v2 ---
echo.
echo [8/13] Treinando Brain v2...
call npm run teach
if errorlevel 1 (
    echo [AVISO] Brain v2 training falhou
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 9: Commander Specialist ---
echo.
echo [9/13] Treinando especialista Commander...
call npx tsx server/scripts/trainCommander.ts
if errorlevel 1 (
    echo [AVISO] Commander training falhou
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 10: Self-Play continuo ---
echo.
echo [10/13] Self-Play Loop (%ITERATIONS% iteracoes)...
call npx tsx server/scripts/continuousTraining.ts
if errorlevel 1 (
    echo [AVISO] continuousTraining falhou
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 11: Verificar pesos ---
echo.
echo [11/13] Verificando pesos aprendidos...
call npm run check:learn
if errorlevel 1 (
    echo [AVISO] check:learn falhou
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 12: Testes de regressao ---
echo.
echo [12/13] Testes de regressao do modelo...
call npm run test:model
if errorlevel 1 (
    echo [AVISO] Testes de modelo falharam
    set /a ERRORS=ERRORS+1
) else (
    echo    OK
)

:: --- PASSO 13: Suite vitest ---
echo.
echo [13/13] Suite de testes vitest...
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
echo    Passos: 13   Avisos: %ERRORS%
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
