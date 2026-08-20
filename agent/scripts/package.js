/**
 * Empaqueta el agente en un .zip listo para copiar al servidor Windows.
 *
 * Salida: agent/dist-bin/playerytees-sync-agent-v<version>-<date>.zip
 *
 * Contenido del zip:
 *   dist/                       - código TS compilado
 *   node_modules/               - dependencias (sin devDeps)
 *   agent.config.example.json   - plantilla de configuración
 *   package.json                - info de versión
 *   README.md                   - instrucciones de despliegue
 *   install.bat                 - script de instalación como servicio
 *   uninstall.bat               - script de desinstalación
 *
 * Uso:
 *   node scripts/package.js
 *   # o
 *   pnpm run package
 *
 * Resultado: ~25 MB zip (sin .exe, sin native bindings de better-sqlite3
 * — estos se regeneran al primer arranque en Windows via prebuild-install).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist-bin');

function main() {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const date = new Date().toISOString().slice(0, 10);
  const zipName = `playerytees-sync-agent-v${pkg.version}-${date}.zip`;
  const zipPath = path.join(outDir, zipName);

  // 1) Compilar TS.
  console.log('[package] Compilando TS...');
  execSync('npx tsc -p tsconfig.json', { cwd: root, stdio: 'inherit' });

  // 2) Limpiar node_modules previos y reinstalar solo production deps.
  // Importante: en Windows los binarios nativos (better-sqlite3.node)
  // deben estar compilados para Node 20 + Win32-x64, no para macOS.
  // Como no podemos garantizar que estén correctos aquí, los regeneramos
  // al primer arranque con prebuild-install (el postinstall hook lo hace).
  console.log('[package] Reinstalando node_modules (production only)...');
  const nmPath = path.join(root, 'node_modules');
  if (fs.existsSync(nmPath)) {
    fs.rmSync(nmPath, { recursive: true, force: true });
  }
  execSync('pnpm install --prod --ignore-workspace', { cwd: root, stdio: 'inherit' });

  // 3) Generar .bat para install/uninstall como servicio.
  const installBat = `@echo off
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
node dist\\install\\install-windows-service.js

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
`;

  const uninstallBat = `@echo off
REM Desinstala el servicio.
REM EJECUTAR COMO ADMINISTRADOR.

setlocal
cd /d "%~dp0"

echo.
echo === playerytees-sync-agent: desinstalando servicio ===
echo.

node dist\\install\\uninstall-windows-service.js

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
`;

  fs.writeFileSync(path.join(root, 'install.bat'), installBat);
  fs.writeFileSync(path.join(root, 'uninstall.bat'), uninstallBat);

  // 4) Crear el zip excluyendo lo que no se necesita.
  console.log(`[package] Creando zip: ${zipPath}`);
  try {
    // macOS trae `zip` por defecto.
    execSync(
      `zip -r "${zipPath}" dist node_modules agent.config.example.json package.json README.md install.bat uninstall.bat ` +
      `-x "node_modules/.cache/*" "node_modules/.bin/*" "node_modules/*/test/*" "node_modules/*/tests/*" ` +
      `"node_modules/*/docs/*" "node_modules/*/examples/*" "node_modules/*/.github/*" ` +
      `"dist/install/*.map"`,
      { cwd: root, stdio: 'inherit' },
    );
  } catch (err) {
    console.error('');
    console.error('[package] ERROR creando zip. Si no tienes `zip` instalado, instala con: brew install zip');
    console.error(err.message);
    process.exit(1);
  }

  console.log('');
  console.log('[package] OK!');
  console.log(`[package] Salida: ${zipPath}`);
  console.log('');
  console.log('Próximos pasos:');
  console.log('  1. Copia el .zip al servidor Windows donde corre Firebird.');
  console.log('  2. Descomprime en C:\\Servicios\\playerytees-sync-agent\\');
  console.log('  3. Renombra agent.config.example.json a agent.config.json y edita.');
  console.log('  4. Ejecuta install.bat como administrador.');
  console.log('  5. Verifica en services.msc que el servicio está "En ejecución".');
  console.log('');
}

main();