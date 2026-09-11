@echo off
REM HandScribe starter - double-click to run. Everything stays in this folder.
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [HandScribe] Node.js / npm not found. Install Node 20+ LTS from https://nodejs.org/ first.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [HandScribe] First run - installing dependencies locally into .\node_modules ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [HandScribe] npm install failed. See errors above.
    pause
    exit /b 1
  )
)

echo [HandScribe] Starting dev server at http://localhost:5173 ...
echo [HandScribe] Keep this window open. Press Ctrl+C to stop.
start "" "http://localhost:5173"
call npm run dev
pause
