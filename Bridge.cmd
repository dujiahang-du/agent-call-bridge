@echo off
setlocal
set "ACB_ROOT=%~dp0"
if exist "%ACB_ROOT%runtime\node.exe" (
  "%ACB_ROOT%runtime\node.exe" "%ACB_ROOT%dist\bridge\cli.js" %* --connection "%ACB_ROOT%.local\connection.json"
) else (
  node "%ACB_ROOT%dist\bridge\cli.js" %* --connection "%ACB_ROOT%.local\connection.json"
)
