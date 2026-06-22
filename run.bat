@echo off
REM Verity — start backend (8077) + frontend (5173) in their own windows, open browser.
cd /d "%~dp0"

echo Installing backend deps (first run only)...
python -m pip install -q -r requirements.txt

echo Starting backend on http://localhost:8077 ...
start "Verity backend" cmd /k python -m uvicorn app.main:app --port 8077 --app-dir "%~dp0."

echo Starting frontend on http://localhost:5173 ...
start "Verity frontend" cmd /k "cd /d %~dp0web && npm install && npm run dev -- --port 5173"

echo Waiting for servers to boot...
timeout /t 6 >nul
start "" http://localhost:5173

echo.
echo Verity is starting. Two windows opened (backend + frontend).
echo Close those windows to stop the servers.
