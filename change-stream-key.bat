@echo off
rem Asks for a new stream key and saves it to config.json.
rem (You can also change it in the dock: Settings.)
setlocal
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
"%NODE%" src\setup.js
pause
