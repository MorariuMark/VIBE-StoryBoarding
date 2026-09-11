@echo off
REM Start the Audio8 GPU server with the project-local venv.
setlocal
cd /d %~dp0\..
if not exist "server\python\.venv\Scripts\python.exe" (
  echo [audio8] project venv missing — run scripts\setup-audio8.bat first.
  exit /b 1
)
server\python\.venv\Scripts\python.exe server\python\audio8_server.py --host 127.0.0.1 --port 8010
