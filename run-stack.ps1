#Requires -Version 5.0
<#
.SYNOPSIS
    MTG AI - Runtime Stack Launcher (ml_engine + Node server + Forge worker)
.DESCRIPTION
    Starts the three runtime services required for the 8-pillar stack with
    clean graceful shutdown on Ctrl+C:

      1. ml_engine FastAPI bridge   (http://127.0.0.1:8765)
      2. Node API server            (dev mode via npm run dev)
      3. (Optional) Forge worker    (stub - enable when Forge bridge is ready)

    On Ctrl+C, all three are terminated tree-wide via taskkill /F /T so no
    orphaned Java / Python processes are left behind.

    NOTE: This script does NOT replace run-all.ps1 (the training pipeline).
    Use this one for DAY-TO-DAY dev; use run-all.ps1 for a full retrain.

.USAGE
    .\run-stack.ps1                          # foreground, Ctrl+C to stop
    .\run-stack.ps1 -SkipMl                  # skip ml_engine (Node only)
    .\run-stack.ps1 -SkipForge               # skip Forge worker (default)
    .\run-stack.ps1 -PythonBin python3.11    # override Python interpreter

.NOTES
    Each subprocess is launched via Start-Process so we own its PID and can
    kill its whole tree on shutdown. Stderr/stdout stream to per-service log
    files under ./logs/.

    If you get "running scripts is disabled on this system", run ONCE:
        Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
    Or invoke this script via:
        powershell -ExecutionPolicy Bypass -File .\run-stack.ps1
#>
param(
    [string]$PythonBin   = "",
    [switch]$SkipMl      = $false,
    [switch]$SkipForge   = $true,
    [int]   $RagPort     = 8765,
    [int]   $NodePort    = 3000
)

$ErrorActionPreference = "Stop"

# --- Resolve Python interpreter ----------------------------------------------
# Priority: caller-supplied -PythonBin → $env:PYTHON → .venv (repo-local) → venv → system `python`.
# The repo-local venv has the ML deps (ray, gymnasium, sentence_transformers, ...).
# The system `python` on Windows 11 typically resolves to 3.14 without those
# packages, which makes the ml_engine /health probe fail during startup.
if (-not $PythonBin) {
    $candidates = @()
    if ($env:PYTHON) { $candidates += $env:PYTHON }
    $candidates += (Join-Path $PSScriptRoot ".venv\Scripts\python.exe")
    $candidates += (Join-Path $PSScriptRoot "venv\Scripts\python.exe")
    $PythonBin = "python"
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { $PythonBin = $c; break }
    }
}

# --- Ensure logs/ exists -----------------------------------------------------
$logDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# --- Track child PIDs for cleanup --------------------------------------------
$global:ChildPids = @()

function Start-Service-Process {
    param(
        [string]$Name,
        [string]$Cmd,
        [string]$ArgList,           # renamed from $Args - $Args is a PS automatic var
        [string]$WorkingDir = $PSScriptRoot
    )
    $logPath = Join-Path $logDir "$Name.log"
    Write-Host "[$Name] starting - log: $logPath" -ForegroundColor Cyan

    $proc = Start-Process -FilePath $Cmd `
        -ArgumentList $ArgList `
        -WorkingDirectory $WorkingDir `
        -PassThru `
        -NoNewWindow `
        -RedirectStandardOutput $logPath `
        -RedirectStandardError "$logPath.err"

    if ($proc) {
        $global:ChildPids += $proc.Id
        Write-Host "[$Name] pid=$($proc.Id)" -ForegroundColor DarkGreen
        return $proc
    }
    else {
        Write-Host "[$Name] failed to start" -ForegroundColor Red
        return $null
    }
}

function Stop-All {
    Write-Host ""
    Write-Host "--- Shutting down stack -----------------------------------------" -ForegroundColor Yellow
    foreach ($cpid in $global:ChildPids) {
        try {
            $running = Get-Process -Id $cpid -ErrorAction SilentlyContinue
            if ($running) {
                Write-Host "  killing pid=$cpid ($($running.ProcessName))" -ForegroundColor DarkYellow
                # /T = terminate the whole process tree (Java subprocesses,
                # uvicorn workers, nodemon children, etc.)
                & taskkill /F /T /PID $cpid 2>&1 | Out-Null
            }
        }
        catch {
            # Process may have already exited - ignore
        }
    }
    $global:ChildPids = @()
    Write-Host "--- Stack stopped -----------------------------------------------" -ForegroundColor Yellow
}

# --- Register Ctrl+C handler -------------------------------------------------
# Register-EngineEvent fires on the PowerShell engine exit -- covers Ctrl+C,
# window close, and clean script completion. An earlier version tried to hook
# [Console]::add_CancelKeyPress with a scriptblock, but PS 5.1 does NOT auto-
# wrap scriptblocks as .NET event handlers, so that line threw InvalidOperation
# and the script died silently before starting any service.
$null = Register-EngineEvent PowerShell.Exiting -Action {
    Stop-All
}

# --- Preflight ---------------------------------------------------------------
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "     MTG AI - Runtime Stack" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "     ml_engine  : $(if ($SkipMl)    { 'SKIPPED' } else { "http://127.0.0.1:$RagPort" })" -ForegroundColor White
Write-Host "     Node API   : http://localhost:$NodePort" -ForegroundColor White
Write-Host "     Forge      : $(if ($SkipForge) { 'SKIPPED' } else { 'enabled' })"             -ForegroundColor White
Write-Host "     Python     : $PythonBin" -ForegroundColor White
Write-Host "     Logs       : $logDir" -ForegroundColor White
Write-Host "  ============================================================" -ForegroundColor Cyan

# --- Service 1: ml_engine FastAPI --------------------------------------------
if (-not $SkipMl) {
    $env:RAG_SERVER_PORT = $RagPort
    $mlProc = Start-Service-Process `
        -Name    "ml_engine" `
        -Cmd     $PythonBin `
        -ArgList "-m ml_engine.rag.server"
    if (-not $mlProc) {
        Write-Host "Aborting - ml_engine failed to start" -ForegroundColor Red
        Stop-All
        exit 1
    }

    # Wait for health endpoint (up to 30s)
    Write-Host "[ml_engine] waiting for /health..." -ForegroundColor DarkGray
    $healthy = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$RagPort/health" `
                -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) { $healthy = $true; break }
        }
        catch { Start-Sleep -Seconds 1 }
    }
    if (-not $healthy) {
        Write-Host "[ml_engine] did NOT become healthy in 30s - check logs/ml_engine.log" -ForegroundColor Red
        Stop-All
        exit 1
    }
    Write-Host "[ml_engine] healthy OK" -ForegroundColor Green
}

# --- Service 2: Node API -----------------------------------------------------
# npm.cmd is the actual executable on Windows; calling "npm" directly via
# Start-Process looks up npm.ps1 which fails because of its shebang on PS 5.1.
$npmCmd = if ($IsWindows -or $env:OS -eq "Windows_NT") { "npm.cmd" } else { "npm" }
$nodeProc = Start-Service-Process `
    -Name    "node_api" `
    -Cmd     $npmCmd `
    -ArgList "run dev"

if (-not $nodeProc) {
    Write-Host "Aborting - Node API failed to start" -ForegroundColor Red
    Stop-All
    exit 1
}

# --- Service 3: Forge worker (optional) --------------------------------------
if (-not $SkipForge) {
    # Placeholder - wire up the Java Forge subprocess launcher here when the
    # Python<->Java bridge is finalized.
    Write-Host "[forge] worker launch not yet implemented" -ForegroundColor DarkYellow
}

# --- Idle loop: keep script alive, show heartbeat ----------------------------
Write-Host ""
Write-Host "  ------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "    Stack running. Press Ctrl+C to stop." -ForegroundColor Cyan
Write-Host "  ------------------------------------------------------------" -ForegroundColor Cyan

try {
    while ($true) {
        Start-Sleep -Seconds 10
        # Reap dead children - if any critical service died, tear down the rest
        foreach ($cpid in @($global:ChildPids)) {
            $alive = Get-Process -Id $cpid -ErrorAction SilentlyContinue
            if (-not $alive) {
                Write-Host "[watchdog] pid=$cpid died unexpectedly - shutting down" -ForegroundColor Red
                Stop-All
                exit 1
            }
        }
    }
}
finally {
    Stop-All
}
