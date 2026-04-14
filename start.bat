@echo off
title MC Region Tool
echo.
echo  Checking for Node.js...
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo  ERROR: Node.js not found. Download it from https://nodejs.org
    pause
    exit /b 1
)
echo  Installing dependencies...
call npm install --silent
echo  Starting MC Region Tool...
echo  Browser will open automatically at http://localhost:25599
echo  Press Ctrl+C to stop the server.
echo.
node server.js
pause
