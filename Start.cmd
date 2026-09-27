@echo off
title Agent Call Bridge
color 0F
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" -Interactive %*
