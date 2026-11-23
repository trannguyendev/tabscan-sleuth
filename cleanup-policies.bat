@echo off
title Tab-Sleuth - Clean Up Chrome Policies

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Administrator privileges required. Please right-click this file and "Run as administrator".
    pause
    exit /b 1
)

echo Cleaning up Chrome extension policies...
reg delete "HKCU\Software\Policies\Google\Chrome\ExtensionInstallForcelist" /f >nul 2>&1
reg delete "HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist" /f >nul 2>&1
reg delete "HKCU\Software\Policies\Google\Chrome\ExtensionInstallAllowlist" /f >nul 2>&1
reg delete "HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist" /f >nul 2>&1

echo.
echo [SUCCESS] Policies removed cleanly! Chrome will no longer show [BLOCKED] errors in chrome://policy.
echo.
pause
exit /b 0
