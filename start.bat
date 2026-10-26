@echo off
rem InstantDelay launcher for Windows: double-click to start.
rem Installs Node.js and ffmpeg with winget if they are missing, asks for the
rem stream key on first run, then starts the delay proxy.
setlocal
cd /d "%~dp0"
title InstantDelay

rem ---------------------------------------------------------------- Node.js
set "NODE=node"
where node >nul 2>nul && goto have_node
set "NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%NODE%" goto have_node
echo Node.js is not installed. Installing it now with winget...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if exist "%NODE%" goto have_node
echo.
echo Could not install Node.js automatically.
echo Install the LTS version from https://nodejs.org and then run start.bat again.
pause
exit /b 1
:have_node

rem ----------------------------------------------------------------- ffmpeg
where ffmpeg >nul 2>nul && goto have_ffmpeg
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" goto have_ffmpeg
if exist "%~dp0ffmpeg\bin\ffmpeg.exe" goto have_ffmpeg
echo ffmpeg is not installed. Installing it now with winget...
winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
:have_ffmpeg

rem ------------------------------------------------------------ first run
if exist config.json goto run
"%NODE%" src\setup.js
if exist config.json goto run
echo Setup did not finish. Run start.bat again.
pause
exit /b 1

:run
"%NODE%" src\server.js
echo.
echo InstantDelay has stopped.
pause
