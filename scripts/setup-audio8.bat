@echo off
REM Setup Audio8 GPU backend — everything project-local, nothing global.
REM Creates server\python\.venv, installs CUDA torch + deps, downloads models into models\.
setlocal
cd /d %~dp0\..

REM Keep pip's wheel cache inside the project too (default is %LOCALAPPDATA%\pip).
set PIP_CACHE_DIR=%CD%\.cache\pip
if not exist ".cache\pip" mkdir ".cache\pip"

if not exist "server\python\.venv\Scripts\python.exe" (
  echo [setup] creating project venv: server\python\.venv
  python -m venv "server\python\.venv"
  if errorlevel 1 ( echo [setup] FAILED: python -m venv failed & exit /b 1 )
)

set PY=server\python\.venv\Scripts\python.exe
echo [setup] upgrading pip...
"%PY%" -m pip install -U pip
echo [setup] installing CUDA torch (project venv only)...
"%PY%" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
if errorlevel 1 ( echo [setup] FAILED: torch install failed & exit /b 1 )
echo [setup] installing server deps...
"%PY%" -m pip install -r server\python\requirements-audio8.txt
if errorlevel 1 ( echo [setup] FAILED: deps install failed & exit /b 1 )
echo [setup] downloading models into models\ ...
"%PY%" server\python\download_models.py
if errorlevel 1 ( echo [setup] FAILED: model download failed & exit /b 1 )
echo [setup] DONE. Start the GPU server with scripts\start-audio8.bat
