# 🤖 Claude Code Configuration

Este directorio contiene la configuración de **Claude Code** para el proyecto NOVA Microservicio Autos.

## 📁 Estructura

```
.claude/
├── README.md                    ← Este archivo
└── settings.template.json       ← Configuración de plugins y MCP servers
```

---

## ⚙️ settings.template.json

Archivo de configuración que define los plugins habilitados y los servidores MCP (Model Context Protocol).

### 🔌 Plugins Habilitados

| Plugin              | Descripción                               | Uso                                                |
| ------------------- | ----------------------------------------- | -------------------------------------------------- |
| `context7`          | Documentación de librerías en tiempo real | Consulta docs actualizadas de NestJS, Prisma, etc. |
| `frontend-design`   | Asistencia en diseño frontend             | Ayuda con CSS, layouts, componentes UI             |
| `code-review`       | Revisión de código automatizada           | Detecta code smells, sugiere mejoras               |
| `playwright`        | Testing E2E con Playwright                | Genera y ejecuta tests de integración              |
| `typescript-lsp`    | Language Server Protocol                  | Autocompletado, navegación, refactoring            |
| `commit-commands`   | Comandos de Git/Commits                   | Genera commits semánticos, gestiona branches       |
| `security-guidance` | Guía de seguridad                         | Detecta vulnerabilidades, sugiere fixes            |
| `pr-review-toolkit` | Herramientas para PRs                     | Review de Pull Requests automatizado               |
| `ralph-loop`        | Loop de desarrollo iterativo              | Ejecución continua de tareas complejas             |

### 🔧 MCP Servers

#### Chrome DevTools MCP

```json
{
  "chrome-devtools": {
    "command": "npx",
    "args": ["-y", "chrome-devtools-mcp@latest"],
    "description": "Google Chrome DevTools MCP"
  }
}
```

**Capacidades:**

- 🔍 **Inspección de consola** - Ver logs, errores y warnings
- 🌐 **Network tab** - Analizar peticiones HTTP/WebSocket
- ⚡ **Performance traces** - Capturar y analizar rendimiento
- 🐛 **Debugging** - Depuración remota via DevTools Protocol

**Uso típico:**

```bash
# Inicia Chrome con debugging habilitado
chrome --remote-debugging-port=9222

# Claude puede entonces:
# - Capturar screenshots
# - Inspeccionar elementos
# - Analizar network requests
# - Ejecutar JavaScript en la consola
```

---

## 🚀 Cómo Usar

### 1. Copiar la plantilla

```bash
cp .claude/settings.template.json .claude/settings.json
```

### 2. Personalizar (opcional)

Edita `settings.json` para habilitar/deshabilitar plugins según tus necesidades:

```json
{
  "enabledPlugins": {
    "context7@claude-plugins-official": true,
    "playwright@claude-plugins-official": false // Deshabilitar si no usas Playwright
  }
}
```

### 3. Agregar más MCP Servers (opcional)

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "POSTGRES_CONNECTION_STRING": "postgresql://..."
      }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    }
  }
}
```

---

## 📚 Plugins en Detalle

### 🔎 Context7

Permite consultar documentación actualizada de cualquier librería:

```
"¿Cómo uso @UseGuards en NestJS?"
→ Context7 busca en docs oficiales de NestJS
→ Retorna ejemplos actualizados y best practices
```

### 🛡️ Security Guidance

Analiza tu código en busca de vulnerabilidades:

- SQL Injection
- XSS (Cross-Site Scripting)
- CSRF (Cross-Site Request Forgery)
- Secrets expuestos
- Dependencias vulnerables

### 📝 Commit Commands

Genera commits siguiendo Conventional Commits:

```
feat(car): add VIN validation endpoint
fix(auth): resolve JWT expiration issue
docs(readme): update installation steps
```

### 🎭 Playwright

Genera tests E2E automáticamente:

```typescript
// Claude puede generar esto basándose en tu API
test('should create a car', async ({ request }) => {
  const response = await request.post('/api/cars', {
    data: { vin: 'ABC123', year: 2024 },
  });
  expect(response.status()).toBe(201);
});
```

---

## 🔐 Seguridad

> ⚠️ **IMPORTANTE**: El archivo `settings.json` puede contener tokens y credenciales.

1. **NO** commitear `settings.json` con credenciales
2. Usa `settings.template.json` como plantilla sin secretos
3. Agrega `settings.json` a `.gitignore`:

```gitignore
# Claude
.claude/settings.json
```

---

## 🤝 Contribuir

Para agregar nuevos plugins o MCP servers al proyecto:

1. Actualiza `settings.template.json`
2. Documenta el nuevo plugin en este README
3. Crea un PR con la descripción del cambio

---

## 📖 Referencias

- [Claude Code Documentation](https://docs.anthropic.com/claude-code)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP Servers Directory](https://github.com/modelcontextprotocol/servers)
