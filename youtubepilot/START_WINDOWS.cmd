@echo off
setlocal
cd /d "%~dp0"
where docker >nul 2>nul || (echo Docker Desktop is required.& pause & exit /b 1)
if not exist .env.local node deploy\generate-local-env.mjs
for /f "usebackq tokens=*" %%A in (".env.local") do set "%%A"
docker compose --env-file .env.local -f docker-compose.local.yml up -d --build
if errorlevel 1 (echo Startup failed. Run docker compose logs app& pause& exit /b 1)
start http://localhost:8080
echo YouTubePilot is running at http://localhost:8080
pause
