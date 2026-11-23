@echo off
setlocal EnableDelayedExpansion
title TabScan Q^&A - Release Publisher
cls
echo ==============================================================================
echo   TabScan Q^&A - Automated GitHub Release Publisher
echo ==============================================================================
echo.

:: 1. Read current version from manifest.json using Node.js JSON parser
for /f "delims=" %%a in ('node -e "console.log(JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version)"') do (
    set CURRENT_VER=%%a
)

if "%CURRENT_VER%"=="" (
    echo [ERROR] Could not read version from manifest.json.
    pause
    exit /b 1
)

echo Current version in manifest.json: v%CURRENT_VER%
echo.
set /p USER_INPUT="Enter release version to publish [press Enter for v%CURRENT_VER%]: "

if "%USER_INPUT%"=="" (
    set NEW_VER=%CURRENT_VER%
) else (
    set NEW_VER=%USER_INPUT%
)

if "%NEW_VER:~0,1%"=="v" set NEW_VER=%NEW_VER:~1%
set TAG=v%NEW_VER%

:: Sync version back to manifest.json if user typed a different version
node -e "const f='manifest.json'; const m=JSON.parse(require('fs').readFileSync(f,'utf8')); m.version='%NEW_VER%'; require('fs').writeFileSync(f, JSON.stringify(m, null, 2) + '\n');"

echo.
echo Packaging release %TAG%...
echo ==============================================================================

:: 2. Run packaging script
node scripts/package-release.mjs --key=key.pem --version=%NEW_VER% --update-url="https://raw.githubusercontent.com/trannguyendev/tabscan-sleuth/main/dist/updates.xml" --codebase-url="https://github.com/trannguyendev/tabscan-sleuth/releases/download/%TAG%/tab-scan-qa.crx"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Packaging failed!
    pause
    exit /b 1
)

:: 3. Sync git
echo.
echo Syncing updates.xml and files to git...
git add .
git commit -m "chore(release): prepare %TAG%" >nul 2>&1
git push origin main
if %errorlevel% neq 0 (
    echo [WARNING] Git push failed or nothing to commit. Continuing...
)

:: 4. Create GitHub Release and upload ALL assets: Installer, Updater, ZIP, and CRX!
echo.
echo Publishing %TAG% to GitHub Releases with all assets...
"C:\Program Files\GitHub CLI\gh.exe" release create %TAG% ^
  "Install-TabSleuth.bat#Install-TabSleuth.bat" ^
  "update.bat#update.bat" ^
  "dist/tab-scan-qa.zip#tab-scan-qa.zip" ^
  "dist/tab-scan-qa.crx#tab-scan-qa.crx" ^
  --repo trannguyendev/tabscan-sleuth ^
  --title "%TAG% - Tab-Sleuth Release" ^
  --generate-notes

if %errorlevel% neq 0 goto :RELEASE_ERROR

echo.
echo ==============================================================================
echo   [SUCCESS] %TAG% Published Successfully to GitHub!
echo ==============================================================================
echo.
echo   Uploaded assets:
echo     1. Install-TabSleuth.bat  - 1-Click Installer for new users
echo     2. update.bat             - 1-Click Updater for existing users
echo     3. tab-scan-qa.zip        - Unpacked source package
echo     4. tab-scan-qa.crx        - Signed Chrome extension
echo.
echo   View release at:
echo     https://github.com/trannguyendev/tabscan-sleuth/releases/tag/%TAG%
echo ==============================================================================
echo.
pause
exit /b 0

:RELEASE_ERROR
echo.
echo ==============================================================================
echo   [ERROR] Failed to create GitHub release.
echo ==============================================================================
echo.
pause
exit /b 1