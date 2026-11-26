param(
  [ValidateSet('Setup','Start')][string]$Action = 'Start',
  [string]$TunnelClient = (Join-Path $env:USERPROFILE 'tools\openai-tunnel-client\v0.0.19\bin\tunnel-client-runtime.exe')
)
# Connects the local read-only MCP endpoint to ChatGPT through OpenAI Secure MCP Tunnel (outbound only).
# Secrets stay in .env (server <-> tunnel token) and .secrets\chatgpt-tunnel.env (Platform runtime key). Nothing is printed.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
$tunnelFile = Join-Path $projectRoot '.secrets\chatgpt-tunnel.env'
function Read-EnvFile([string]$path) {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $path) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $values[$Matches[1]] = $Matches[2].Trim('"') }
  }
  return $values
}
switch ($Action) {
  'Setup' {
    $server = Read-EnvFile $envFile
    if (-not $server['TUNNEL_MCP_BEARER_TOKEN']) {
      $bytes = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      Add-Content -LiteralPath $envFile -Value ("TUNNEL_MCP_BEARER_TOKEN=" + (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')) -Encoding utf8
      Write-Output 'TUNNEL_MCP_BEARER_TOKEN gerado em .env (reinicie o servidor).'
    }
    if (-not (Test-Path -LiteralPath $tunnelFile)) {
      New-Item -ItemType Directory -Force (Split-Path $tunnelFile) | Out-Null
      Set-Content -LiteralPath $tunnelFile -Encoding utf8 -Value @(
        '# Preencha com os dados do túnel criado em https://platform.openai.com/settings/organization/tunnels',
        '# Não compartilhe este arquivo. Ele está ignorado pelo Git.',
        'CONTROL_PLANE_TUNNEL_ID=',
        'CONTROL_PLANE_API_KEY=')
      Write-Output "Modelo criado: $tunnelFile — preencha CONTROL_PLANE_TUNNEL_ID e CONTROL_PLANE_API_KEY."
    }
  }
  'Start' {
    if (-not (Test-Path -LiteralPath $TunnelClient)) { throw "tunnel-client não encontrado em $TunnelClient" }
    $server = Read-EnvFile $envFile; $tunnel = Read-EnvFile $tunnelFile
    if (-not $server['TUNNEL_MCP_PORT'] -or -not $server['TUNNEL_MCP_BEARER_TOKEN']) { throw 'Configure TUNNEL_MCP_PORT e rode -Action Setup.' }
    if (-not $tunnel['CONTROL_PLANE_TUNNEL_ID'] -or -not $tunnel['CONTROL_PLANE_API_KEY']) { throw "Preencha $tunnelFile." }
    # Process-scoped variables only; referenced by name (env:VAR) so values never appear in the command line.
    $env:CONTROL_PLANE_API_KEY = $tunnel['CONTROL_PLANE_API_KEY']
    $env:CONTROL_PLANE_TUNNEL_ID = $tunnel['CONTROL_PLANE_TUNNEL_ID']
    $env:OLIST_TUNNEL_AUTH = 'Bearer ' + $server['TUNNEL_MCP_BEARER_TOKEN']
    $env:MCP_SERVER_URL = "http://127.0.0.1:$($server['TUNNEL_MCP_PORT'])/mcp"
    & $TunnelClient run --mcp.extra-headers 'Authorization: env:OLIST_TUNNEL_AUTH' --mcp.discovery-extra-headers 'Authorization: env:OLIST_TUNNEL_AUTH' --health.listen-addr '127.0.0.1:8090' --log.file (Join-Path $projectRoot '.local\tunnel.log')
    exit $LASTEXITCODE
  }
}
