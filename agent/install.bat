@echo off
REM Instala el agente como servicio nativo de Windows.
REM EJECUTAR COMO ADMINISTRADOR.

setlocal
cd /d "%~dp0"

echo.
echo === playerytees-sync-agent: instalando servicio ===
echo.

REM Verificar que node está en PATH.
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js no esta en PATH. Instala Node 20 LTS primero.
  echo        https://nodejs.org/en/download
  pause
  exit /b 1
)

REM Verificar que agent.config.json existe.
if not exist "agent.config.json" (
  echo.
  echo No se encontro agent.config.json.
  echo Copia agent.config.example.json a agent.config.json y edita los valores.
  echo.
  pause
  exit /b 1
)

REM Instalar servicio.
node dist\install\install-windows-service.js

if errorlevel 1 (
  echo.
  echo ERROR: la instalacion fallo. Revisa el log arriba.
  pause
  exit /b 1
)

echo.
echo OK. El servicio "playerytees-sync-agent" esta instalado y arrancado.
echo Para administrarlo: services.msc
echo Para ver logs: Visor de eventos ^> Registros de Windows ^> Aplicacion
echo.
pause
