@echo off
setlocal EnableDelayedExpansion
title TabScan Q^&A - Release Publisher
cls
echo ==============================================================================
echo   TabScan Q^&A - Automated GitHub Release Publisher
echo ==============================================================================
echo.

:: 1. Read current version from manifest.json
for /f "tokens=2 delims=:, " %%a in ('findstr /i "\"version\"" manifest.json') do (
    set CURRENT_VER=%%~a
)
echo Current version in manifest.json: v!CURRENT_VER!
echo.
set /p NEW_VER="Enter release version to publish (press Enter for v!CURRENT_VER!): "
if "!NEW_VER!"=="" set NEW_VER=!CURRENT_VER!
if "!NEW_VER:~0,1!"=="v" set NEW_VER=!NEW_VER:~1!
set TAG=v!NEW_VER!

echo.
echo Packaging version !TAG!...
echo ==============================================================================

:: 2. Run packaging script
node scripts/package-release.mjs --key=key.pem --version=!NEW_VER! --update-url="https://raw.githubusercontent.com/trannguyendev/tabscan-sleuth/main/dist/updates.xml" --codebase-url="https://github.com/trannguyendev/tabscan-sleuth/releases/download/!TAG!/tab-scan-qa.crx"
if %errorlevel% neq 0 (
    echo [ERROR] Packaging failed!
    pause
    exit /b 1
)

:: 3. Sync git
echo.
echo Syncing updates.xml and files to git...
git add .
git commit -m "chore(release): prepare !TAG!" >nul 2>&1
git push origin main
if %errorlevel% neq 0 (
    echo [WARNING] Git push failed or nothing to commit. Continuing...
)

:: 4. Create GitHub Release and upload ALL assets: CRX, ZIP, and BAT!
echo.
echo Publishing !TAG! to GitHub Releases with all assets...
"C:\Program Files\GitHub CLI\gh.exe" release create !TAG! ^
  "dist/tab-scan-qa.crx#tab-scan-qa.crx" ^
  "dist/tab-scan-qa.zip#tab-scan-qa.zip" ^
  "enable-tabscan-updates.bat#enable-tabscan-updates.bat" ^
  --repo trannguyendev/tabscan-sleuth ^
  --title "!TAG! ? Tab-Sleuth Release" ^
  --generate-notes

if %errorlevel% equ 0 (
    echo.
    echo ==============================================================================
    echo   [SUCCESS] !TAG! Published Successfully to GitHub!
    echo ==============================================================================
    echo.
    echo   Uploaded assets:
    echo     1. tab-scan-qa.crx            (Signed Chrome extension)
    echo     2. tab-scan-qa.zip            (Unpacked source package)
    echo     3. enable-tabscan-updates.bat (1-Click Auto-Update Setup)
    echo.
    echo   View release at:
    echo     https://github.com/trannguyendev/tabscan-sleuth/releases/tag/!TAG!
    echo ==============================================================================
) else (
    echo.
    echo [ERROR] Failed to create GitHub release.
)

echo.
pause