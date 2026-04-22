@echo off
REM Launch the Forge RL bridge. Run from any CWD — we anchor paths to this script's dir.
setlocal
set SCRIPT_DIR=%~dp0
set FORGE_DIR=%SCRIPT_DIR%..\
set FORGE_JAR=%FORGE_DIR%forge-gui-desktop\target\forge-gui-desktop-2.0.12-SNAPSHOT-jar-with-dependencies.jar
set BRIDGE_JAR=%SCRIPT_DIR%target\rlbridge.jar

if not exist "%FORGE_JAR%" (
  echo [run.cmd] Forge fat jar not found: %FORGE_JAR%
  echo           Build it with: cd forge ^&^& mvn package -pl forge-gui-desktop -am -DskipTests
  exit /b 1
)
if not exist "%BRIDGE_JAR%" (
  echo [run.cmd] Bridge jar not found: %BRIDGE_JAR%
  echo           Build it with: cd forge\rlbridge ^&^& build.cmd
  exit /b 1
)

cd /d "%FORGE_DIR%forge-gui-desktop"
java -Xmx2G -cp "%FORGE_JAR%;%BRIDGE_JAR%" forge.rlbridge.ForgeRLBridge %*
