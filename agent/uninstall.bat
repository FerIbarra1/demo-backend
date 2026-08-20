@echo off
REM Desinstala el servicio.
REM EJECUTAR COMO ADMINISTRADOR.

setlocal
cd /d "%~dp0"

echo.
echo === playerytees-sync-agent: desinstalando servicio ===
echo.

node dist\install\uninstall-windows-service.js

if errorlevel 1 (
  echo.
  echo ERROR: la desinstalacion fallo.
  pause
  exit /b 1
)

echo.
echo OK. Servicio eliminado.
echo.
pause
