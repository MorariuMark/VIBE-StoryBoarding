@echo off
REM HandScribe desktop app — auto-starts the Audio8 GPU sidecar, no more "server not reachable".
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [HandScribe] Node.js / npm not found. Install Node 20+ LTS from https://nodejs.org/ first.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [HandScribe] First run - installing desktop dependencies locally into .\node_modules ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [HandScribe] npm install failed. See errors above.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo [HandScribe] Building the app...
  call npm run build
  if errorlevel 1 (
    echo [HandScribe] build failed. See errors above.
    pause
    exit /b 1
  )
)

echo [HandScribe] Starting desktop app (sidecar + UI managed together)...
call npx electron .
pause
