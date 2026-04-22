@echo off
REM Maven-less build for the bridge — compiles against the Forge fat jar.
setlocal
set SCRIPT_DIR=%~dp0
set FORGE_DIR=%SCRIPT_DIR%..\
set FORGE_JAR=%FORGE_DIR%forge-gui-desktop\target\forge-gui-desktop-2.0.12-SNAPSHOT-jar-with-dependencies.jar

if not exist "%FORGE_JAR%" (
  echo [build.cmd] Forge fat jar not found: %FORGE_JAR%
  echo            Build it first:  cd forge ^&^& mvn package -pl forge-gui-desktop -am -DskipTests
  exit /b 1
)

if not exist "%SCRIPT_DIR%target\classes" mkdir "%SCRIPT_DIR%target\classes"
if not exist "%SCRIPT_DIR%target\classes\META-INF" mkdir "%SCRIPT_DIR%target\classes\META-INF"

echo [build.cmd] javac ForgeRLBridge.java...
javac -cp "%FORGE_JAR%" -d "%SCRIPT_DIR%target\classes" "%SCRIPT_DIR%src\main\java\forge\rlbridge\ForgeRLBridge.java"
if errorlevel 1 (
  echo [build.cmd] javac FAILED
  exit /b 1
)

echo Manifest-Version: 1.0 > "%SCRIPT_DIR%target\classes\META-INF\MANIFEST.MF"
echo Main-Class: forge.rlbridge.ForgeRLBridge >> "%SCRIPT_DIR%target\classes\META-INF\MANIFEST.MF"

echo [build.cmd] jar cfm rlbridge.jar...
cd /d "%SCRIPT_DIR%"
jar cfm target\rlbridge.jar target\classes\META-INF\MANIFEST.MF -C target\classes forge
if errorlevel 1 (
  echo [build.cmd] jar FAILED
  exit /b 1
)

echo [build.cmd] OK → %SCRIPT_DIR%target\rlbridge.jar
