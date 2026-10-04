$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Установите Node.js 22.13 или новее.' }
if (-not (Test-Path -LiteralPath 'node_modules/react')) {
    $taskNodePath = (Get-Command node.exe).Source
    $taskNpmPath = Join-Path (Split-Path -Parent $taskNodePath) 'node_modules/npm/bin/npm-cli.js'
    $env:npm_config_cache = Join-Path $PSScriptRoot '.npm-cache'
    & node $taskNpmPath ci --prefer-offline --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить зависимости.' }
}
if (-not (Test-Path -LiteralPath 'dist/server/wrangler.json')) {
    & node scripts/run-framework.mjs build
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать приложение.' }
}
& node scripts/init-local.mjs
if ($LASTEXITCODE -ne 0) { throw 'Не удалось подготовить базу.' }
Write-Host 'Откройте адрес, который появится ниже. Для остановки нажмите Ctrl+C.'
& node scripts/run-framework.mjs dev
