@echo off
setlocal EnableDelayedExpansion
:: MTG AI - Pipeline Completo (Windows CMD)
:: Uso no CMD       : run-all.bat [formato] [iteracoes] [decks]
:: Uso no PowerShell: .\run-all.bat  OU  .\run-all.ps1 (recomendado)
:: Exemplo          : run-all.bat commander 200 100
::
:: ATENCAO: No PowerShell, use .\run-all.bat ou .\run-all.ps1
:: O PowerShell nao executa .bat sem o prefixo .\
set ARG1=%~1
set ARG2=%~2
set ARG3=%~3
if "%ARG1%"=="" (set FORMAT=modern) else (set FORMAT=%ARG1%)
if "%ARG2%"=="" (set ITERATIONS=100) else (set ITERATIONS=%ARG2%)
if "%ARG3%"=="" (set DECKS=50) else (set DECKS=%ARG3%)
set ERRORS=0

:: ── Detectar run number para rotacionar cores proibidas ──────────
set /a RUN_NUM=0
if exist ".run_counter" set /p RUN_NUM=<.run_counter
set /a RUN_NUM+=1
echo %RUN_NUM%>.run_counter

:: Rotacionar cor proibida: W U B R G (ciclo de 5 runs)
set /a COLOR_IDX=RUN_NUM %% 5
if %COLOR_IDX%==0 set FORBIDDEN_COLOR=W
if %COLOR_IDX%==1 set FORBIDDEN_COLOR=U
if %COLOR_IDX%==2 set FORBIDDEN_COLOR=B
if %COLOR_IDX%==3 set FORBIDDEN_COLOR=R
if %COLOR_IDX%==4 set FORBIDDEN_COLOR=G

:: Pool offset para Self-Play (2000 por run, máx ~50000 cartas)
set /a POOL_OFFSET=(RUN_NUM %% 25) * 2000

echo.
echo ==============================================================
echo    MTG AI - PIPELINE MASTER COMPLETO
echo ==============================================================
echo    Formato:   %FORMAT%
echo    Iteracoes: %ITERATIONS%
echo    Decks:     %DECKS%
echo    Inicio:    %DATE% %TIME%
echo ==============================================================
echo    Run number  : %RUN_NUM%
echo    Cor excluida: %FORBIDDEN_COLOR% (Commander step 8)
echo    Pool offset : %POOL_OFFSET% (Self-Play step 9)
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
echo [2/12] Verificando dependencias (npm install)...
echo    Aguarde, isso pode levar 1-2 minutos na primeira vez...
call npm install --legacy-peer-deps --silent >nul 2>&1
echo    OK (modulos prontos)

:: --- PASSO 3: Migracoes do banco ---
echo.
echo [3/12] Verificando schema do banco de dados...
echo    Aguarde...
call npx tsx server/scripts/applyMigration.ts
if errorlevel 1 (
    echo [AVISO] applyMigration retornou erro
    set /a ERRORS=ERRORS+1
)

:: --- PASSO 4: Sync Scryfall (bulk oracle) ---
echo.
echo [4/12] Sincronizando cartas do Scryfall (bulk oracle)...
echo    Verificando se banco precisa de atualizacao...
call npx tsx server/sync-bulk.ts
if errorlevel 1 (
    echo [AVISO] sync-bulk falhou - usando dados existentes
    set /a ERRORS=ERRORS+1
)

:: --- PASSO 5: Importar decks MTGGoldfish + MTGTop8 ---
echo.
echo [5/12] Importando decks competitivos (MTGGoldfish + MTGTop8)...
echo    Aguarde - compilando TypeScript e conectando aos sites (pode levar 30s)...
call npx tsx import-and-train.ts
if errorlevel 1 (
    echo [AVISO] import-and-train falhou
    set /a ERRORS=ERRORS+1
)

:: --- PASSO 6: Clustering ---
echo.
echo [6/12] Clustering de arquetipos (KMeans)...
echo    Aguarde - analisando decks no banco...
call npx tsx run-clustering.ts
if errorlevel 1 (
    echo [AVISO] Clustering falhou
    set /a ERRORS=ERRORS+1
)

:: --- PASSO 7: Brain v2 ---
echo.
echo [7/12] Treinando Brain v2 (avaliacao de decks)...
echo    Aguarde - este passo pode levar varios minutos...
call npm run teach
if errorlevel 1 (
    echo [AVISO] Brain v2 training falhou
    set /a ERRORS=ERRORS+1
)

:: --- PASSO 8: Commander Specialist ---
echo.
echo [8/12] Commander - DIVERSIDADE DE COR (excluindo %FORBIDDEN_COLOR%)...
echo    Foca nas 4 cores restantes -- garante que o modelo aprenda
echo    identidades de cor sub-representadas no step 7
call npx tsx server/scripts/trainCommander.ts ^
  --iterations=300 ^
  --forbidden-color=%FORBIDDEN_COLOR% ^
  --exploration-mode=true ^
  --source=commander_diversity ^
  --mutation-rate=0.25
if errorlevel 1 (
    echo [AVISO] Commander training falhou
    set /a ERRORS=ERRORS+1
)

:: --- PASSO 9: Self-Play continuo ---
echo.
echo [9/12] Self-Play - POOL ALTERNATIVO (offset=%POOL_OFFSET%)...
echo    Usa fatia diferente do catalogo de 52000 cartas +
echo    mutation rate alto para forcar exploracao de estrategias
call npx tsx server/scripts/continuousTraining.ts ^
  --iterations=%ITERATIONS% ^
  --pool-offset=%POOL_OFFSET% ^
  --pool-size=2000 ^
  --mutation-rate=0.35 ^
  --exploration-mode=true ^
  --source=self_play_explore ^
  --inject-random-pct=0.20
if errorlevel 1 (
    echo [AVISO] continuousTraining falhou
    set /a ERRORS=ERRORS+1
)

:: --- PASSO 10: Verificar pesos ---
echo.
echo [10/12] Verificando pesos aprendidos...
call npm run check:learn
if errorlevel 1 (
    echo [AVISO] check:learn falhou
    set /a ERRORS=ERRORS+1
)

:: --- PASSO 11: Testes de regressao ---
echo.
echo [11/12] Testes de regressao do modelo...
call npm run test:model
if errorlevel 1 (
    echo [AVISO] Testes de modelo falharam
    set /a ERRORS=ERRORS+1
)

:: --- PASSO 12: Suite vitest ---
echo.
echo [12/12] Suite de testes vitest...
call npm test
if errorlevel 1 (
    echo [AVISO] Alguns testes vitest falharam
    set /a ERRORS=ERRORS+1
)

:: --- Relatorio Final ---
echo.
echo ==============================================================
echo    RELATORIO FINAL
echo    Passos: 12   Avisos: %ERRORS%
echo    Termino: %DATE% %TIME%
echo.
echo    Cor treinada   : todas exceto %FORBIDDEN_COLOR%
echo    Pool explorado : cartas %POOL_OFFSET% a %POOL_OFFSET%+2000
echo.
echo    Proximos passos:
echo      1. Inicie o servidor: npm run dev
echo      2. Acesse: http://localhost:3000
echo      3. Repita run-all.bat para treinar mais
echo ==============================================================
echo.
pause
endlocal
