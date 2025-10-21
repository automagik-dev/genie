@echo off
REM Genie Installation Script Wrapper for Windows
REM This batch file runs the PowerShell installation script with Administrator privileges

echo Checking for Administrator privileges...

REM Check for admin rights
net session >nul 2>&1
if %errorLevel% == 0 (
    echo Running with Administrator privileges...
    echo.
    powershell.exe -ExecutionPolicy Bypass -File "%~dp0install.ps1"
) else (
    echo This script requires Administrator privileges.
    echo.
    echo Please right-click this file and select "Run as administrator"
    echo.
    echo Alternatively, run the following command in PowerShell as Administrator:
    echo powershell.exe -ExecutionPolicy Bypass -File "%~dp0install.ps1"
    echo.
    pause
    exit /b 1
)

pause
