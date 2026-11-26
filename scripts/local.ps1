param(
  [ValidateSet('Prepare','Check','Migrate','Start','Build','VerifyConnection')][string]$Action = 'Check',
  [string]$RegisteredCallback
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) { $nodeExe = $nodeCommand.Source }
else {
  $nodeExe = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
  if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'Node.js 24+ ausente. Instale antes de continuar.' }
}
Push-Location $projectRoot
try {
  switch ($Action) {
    'Prepare' { & $nodeExe scripts/prepare-local.mjs }
    'Check' {
      if ($RegisteredCallback) { & $nodeExe --experimental-strip-types scripts/check-local.mjs $RegisteredCallback }
      else { & $nodeExe --experimental-strip-types scripts/check-local.mjs }
    }
    'Build' { & $nodeExe node_modules/typescript/bin/tsc }
    'VerifyConnection' { & $nodeExe --experimental-strip-types scripts/verify-connection.mjs }
    'Migrate' { & $nodeExe --env-file=.env --experimental-strip-types src/migrate.ts }
    'Start' {
      & $nodeExe --experimental-strip-types scripts/check-local.mjs
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      & $nodeExe --env-file=.env --experimental-strip-types src/main.ts
    }
  }
  exit $LASTEXITCODE
} finally { Pop-Location }
