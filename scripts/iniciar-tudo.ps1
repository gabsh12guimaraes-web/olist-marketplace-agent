# Starts everything in order (also used by the Windows logon task): PostgreSQL (Docker), MCP server, ChatGPT tunnel.
# Progress goes to .local\iniciar.log. Nothing secret is printed.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
New-Item -ItemType Directory -Force (Join-Path $projectRoot '.local') | Out-Null
$log = Join-Path $projectRoot '.local\iniciar.log'
function Say([string]$text) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $text"; Write-Output $text; Add-Content -LiteralPath $log -Value $line -Encoding utf8 }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeExe = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }

# Docker Desktop starts with Windows but takes a while; wait up to 4 minutes for the engine.
$ready = $false
for ($i = 0; $i -lt 120 -and -not $ready; $i++) {
  try { docker info --format '{{.ServerVersion}}' 2>$null | Out-Null; $ready = ($LASTEXITCODE -eq 0) } catch { $ready = $false }
  if (-not $ready) { Start-Sleep 2 }
}
if (-not $ready) { Say 'ERRO: Docker nao respondeu em 4 minutos. Abra o Docker Desktop e rode este script de novo.'; exit 1 }
docker start olist-marketplace-agent-postgres-1 | Out-Null
for ($i = 0; $i -lt 60; $i++) {
  if ((docker inspect -f '{{.State.Health.Status}}' olist-marketplace-agent-postgres-1) -eq 'healthy') { break }
  Start-Sleep 2
}
Say 'Banco: ok'

if (-not (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $nodeExe -ArgumentList '--env-file=.env', 'dist/main.js' -WorkingDirectory $projectRoot `
    -RedirectStandardOutput runtime.log -RedirectStandardError runtime-error.log -WindowStyle Hidden
}
$up = $false
for ($i = 0; $i -lt 30 -and -not $up; $i++) {
  try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3001/healthz -TimeoutSec 2 | Out-Null; $up = $true } catch { Start-Sleep 1 }
}
if (-not $up) { Say 'ERRO: servidor nao subiu. Veja runtime-error.log.'; exit 1 }
Say 'Servidor: ok (http://localhost:3000/admin)'

Get-Process tunnel-client-runtime -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $PSScriptRoot 'chatgpt-tunnel.ps1') + '"'), '-Action', 'Start' `
  -WorkingDirectory $projectRoot -RedirectStandardOutput .local\tunnel-console.log -RedirectStandardError .local\tunnel-error.log -WindowStyle Hidden
$ok = $false
# tunnel-client reports readiness (connected to OpenAI and to the MCP server) on its loopback health endpoint.
for ($i = 0; $i -lt 45 -and -not $ok; $i++) {
  Start-Sleep 1
  try { $ok = (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8090/readyz -TimeoutSec 2).Content.Trim() -eq 'ready' } catch { $ok = $false }
}
if ($ok) { Say 'Tunel ChatGPT: ok' } else { Say 'Tunel ChatGPT: verifique .local\tunnel.log' }
