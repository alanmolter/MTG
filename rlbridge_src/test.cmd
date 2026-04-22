@echo off
REM Maven-less test runner for the bridge — compiles + executes the
REM reflection-based unit tests against the built classes.
setlocal
set SCRIPT_DIR=%~dp0
set FORGE_DIR=%SCRIPT_DIR%..\
set FORGE_JAR=%FORGE_DIR%forge-gui-desktop\target\forge-gui-desktop-2.0.12-SNAPSHOT-jar-with-dependencies.jar

if not exist "%SCRIPT_DIR%target\classes\forge\rlbridge\ForgeRLBridge.class" (
  echo [test.cmd] Main classes missing. Run build.cmd first.
  exit /b 1
)

if not exist "%SCRIPT_DIR%target\test-classes" mkdir "%SCRIPT_DIR%target\test-classes"

echo [test.cmd] javac test sources...
javac -cp "%FORGE_JAR%;%SCRIPT_DIR%target\classes" -d "%SCRIPT_DIR%target\test-classes" "%SCRIPT_DIR%src\test\java\forge\rlbridge\ForgeRLBridgeAutoregressiveTest.java"
if errorlevel 1 (
  echo [test.cmd] javac FAILED
  exit /b 1
)

echo [test.cmd] running...
java -cp "%FORGE_JAR%;%SCRIPT_DIR%target\classes;%SCRIPT_DIR%target\test-classes" forge.rlbridge.ForgeRLBridgeAutoregressiveTest
exit /b %errorlevel%
