@echo off
setlocal enabledelayedexpansion
title Tab-Sleuth - 1-Click Installer

set INSTALL_DIR=%LOCALAPPDATA%\TabSleuth
set ZIP_URL=https://github.com/trannguyendev/tabscan-sleuth/releases/latest/download/tab-sleuth.zip
set UPDATE_BAT_URL=https://raw.githubusercontent.com/trannguyendev/tabscan-sleuth/main/update.bat
set TEMP_ZIP=%TEMP%\tab-sleuth-install.zip

cls
echo ==============================================================================
echo   Tab-Sleuth - 1-Click Installer
echo ==============================================================================
echo.
echo Installing Tab-Sleuth to: %INSTALL_DIR%
echo.

REM 1. Create target directory
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

REM 2. Download latest release zip
echo [1/4] Downloading latest extension package from GitHub...
curl.exe -s -L "%ZIP_URL%" -o "%TEMP_ZIP%"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to download package. Please check your internet connection.
    pause
    exit /b 1
)

REM 3. Extract payload
echo [2/4] Extracting extension files...
tar.exe -xf "%TEMP_ZIP%" -C "%INSTALL_DIR%"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to extract extension package.
    del /f /q "%TEMP_ZIP%" >nul 2>&1
    pause
    exit /b 1
)
del /f /q "%TEMP_ZIP%" >nul 2>&1

REM 4. Ensure update.bat is installed
echo [3/4] Installing updater script...
if exist "%~dp0update.bat" (
    copy /y "%~dp0update.bat" "%INSTALL_DIR%\update.bat" >nul
) else (
    curl.exe -s -L "%UPDATE_BAT_URL%" -o "%INSTALL_DIR%\update.bat"
)

REM 5. Create Desktop shortcut for 1-click updating
echo [4/4] Creating "Update Tab-Sleuth" Desktop shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'Update Tab-Sleuth.lnk')); $s.TargetPath = '%INSTALL_DIR%\update.bat'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.Save()" >nul 2>&1

REM 6. Copy folder path to clipboard
echo | set /p="%INSTALL_DIR%" | clip

REM 7. Launch Chrome extensions page
start chrome chrome://extensions

cls
echo ==============================================================================
echo   [SUCCESS] Tab-Sleuth Installed Successfully!
echo ==============================================================================
echo.
echo   Folder Path: %INSTALL_DIR%
echo   (This folder path has been COPIED TO YOUR CLIPBOARD!)
echo.
echo   FINAL 10-SECOND STEP IN GOOGLE CHROME:
echo     1. A Chrome tab has been opened to: chrome://extensions
echo     2. Turn ON "Developer mode" (toggle switch in the top-right corner)
echo     3. Click the "Load unpacked" button (top-left toolbar)
echo     4. Press Ctrl+V in the folder selection bar to paste the path, then press Enter
echo.
echo   HOW UPDATING WORKS FOR YOU:
echo     - An "Update Tab-Sleuth" shortcut was added to your Desktop.
echo     - Whenever there's an update, just double-click that shortcut!
echo.
echo ==============================================================================
echo.
pause
exit /b 0
