@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher-console.ps1" -ProbePath "%~2" -ProbeOnly
if errorlevel 1 exit /b 1
call "%~1\Start.cmd" -NoBrowser
exit /b %errorlevel%
