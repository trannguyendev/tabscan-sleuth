@echo off
title TabScan Q^&A - Enable CRX Auto-Updates

REM ==============================================================================
REM Step 1: Check for Administrator Privileges
REM ==============================================================================
net session >nul 2>&1
if %errorlevel% neq 0 goto :NOT_ADMIN

REM ==============================================================================
REM Step 2: Executed as Administrator - Apply Chrome Extension Whitelist & Force Policy
REM ==============================================================================
cls
echo ==============================================================================
echo   TabScan Q^&A - Applying Chrome Policy Configuration
echo ==============================================================================
echo.
echo Whitelisting Extension ID: jjoepgfpagdecpcbabppbbnblaeklpic ...

REM 1. Allowlist: Permits installation without Web Store block
reg add "HKCU\Software\Policies\Google\Chrome\ExtensionInstallAllowlist" /v 1 /t REG_SZ /d "jjoepgfpagdecpcbabppbbnblaeklpic" /f >nul
reg add "HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist" /v 1 /t REG_SZ /d "jjoepgfpagdecpcbabppbbnblaeklpic" /f >nul

REM 2. Forcelist: Forces Chrome to auto-install & auto-update directly from GitHub
set UPDATE_URL=https://raw.githubusercontent.com/trannguyendev/tabscan-sleuth/main/dist/updates.xml
reg add "HKCU\Software\Policies\Google\Chrome\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "jjoepgfpagdecpcbabppbbnblaeklpic;%UPDATE_URL%" /f >nul
reg add "HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "jjoepgfpagdecpcbabppbbnblaeklpic;%UPDATE_URL%" /f >nul

if %errorlevel% neq 0 goto :ON_ERROR

echo.
echo ==============================================================================
echo   [SUCCESS] Chrome Policy Configured Successfully!
echo ==============================================================================
echo.
echo   Google Chrome policy has been updated. You do NOT need to restart your PC!
echo.
echo   TO ACTIVATE IN CHROME (takes 5 seconds):
echo     1. Open Google Chrome
echo     2. Go to: chrome://policy
echo     3. Click the "Reload policies" button at the top
echo.
echo   Chrome will now recognize TabScan Q^&A and auto-install / auto-update it!
echo   (Or go to chrome://extensions with Developer mode ON and drag tab-scan-qa.crx)
echo.
echo ==============================================================================
echo.
pause
exit /b 0

:ON_ERROR
echo.
echo ==============================================================================
echo   [ERROR] Failed to write policy to the Windows Registry.
echo ==============================================================================
echo.
pause
exit /b 1

:NOT_ADMIN
cls
echo ==============================================================================
echo   ADMINISTRATOR PRIVILEGES REQUIRED
echo ==============================================================================
echo.
echo   This script needs Administrator privileges to configure Google Chrome's
echo   extension policy in the Windows Registry.
echo.
echo   HOW TO PROCEED:
echo     1. Right-click on "enable-tabscan-updates.bat"
echo     2. Click "Run as administrator"
echo.
echo ==============================================================================
echo.
pause
exit /b 1