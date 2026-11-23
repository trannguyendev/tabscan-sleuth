@echo off
setlocal enabledelayedexpansion
title Tab-Sleuth - 1-Click Updater

set INSTALL_DIR=%LOCALAPPDATA%\TabSleuth
set ZIP_URL=https://github.com/trannguyendev/tabscan-sleuth/releases/latest/download/tab-scan-qa.zip
set API_URL=https://api.github.com/repos/trannguyendev/tabscan-sleuth/releases/latest
set TEMP_ZIP=%TEMP%\tab-scan-qa-update.zip

cls
echo ==============================================================================
echo   Tab-Sleuth - 1-Click Updater
echo ==============================================================================
echo.
echo Checking for updates from GitHub...

REM 1. Fetch latest version from GitHub API
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Invoke-RestMethod -Uri '%API_URL%' -Headers @{'User-Agent'='TabSleuthUpdater'}).tag_name" 2^>nul`) do (
    set LATEST_TAG=%%v
)

if "%LATEST_TAG%"=="" (
    echo [WARNING] Could not check latest version via API. Proceeding with download...
    set LATEST_TAG=latest
)

REM 2. Read local version if manifest exists
set LOCAL_VER=unknown
if exist "%INSTALL_DIR%\manifest.json" (
    for /f "usebackq tokens=*" %%v in (`powershell -NoProfile -Command "(Get-Content '%INSTALL_DIR%\manifest.json' -Raw | ConvertFrom-Json).version" 2^>nul`) do (
        set LOCAL_VER=v%%v
    )
)

echo   Installed version: %LOCAL_VER%
echo   Latest version:    %LATEST_TAG%
echo.

REM 3. Download the newest release zip
echo Downloading latest package from GitHub...
curl.exe -s -L "%ZIP_URL%" -o "%TEMP_ZIP%"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to download update. Please check your internet connection.
    pause
    exit /b 1
)

REM 4. Extract into TabSleuth folder
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
echo Updating files in %INSTALL_DIR%...
tar.exe -xf "%TEMP_ZIP%" -C "%INSTALL_DIR%"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to extract update files.
    del /f /q "%TEMP_ZIP%" >nul 2>&1
    pause
    exit /b 1
)

del /f /q "%TEMP_ZIP%" >nul 2>&1

REM Ensure update.bat exists in install directory
copy /y "%~f0" "%INSTALL_DIR%\update.bat" >nul 2>&1

cls
echo ==============================================================================
echo   [SUCCESS] Tab-Sleuth Updated Successfully to %LATEST_TAG%!
echo ==============================================================================
echo.
echo   TO ACTIVATE THE NEW VERSION IN CHROME:
echo     1. Open Google Chrome
echo     2. Go to: chrome://extensions
echo     3. Click the reload (refresh / circular arrow) icon on Tab-Sleuth
echo        (Or simply restart Google Chrome)
echo.
echo ==============================================================================
echo.
pause
exit /b 0
