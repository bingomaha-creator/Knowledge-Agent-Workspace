param([switch]$SkipNeo4j)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $ProjectRoot
# src 布局：后端进程需要从 src 目录定位 deepresearch_agent 包
$env:PYTHONPATH = Join-Path $ProjectRoot "src"

if (-not (Test-Path -LiteralPath ".env")) { throw "Missing .env. Copy .env.example and configure backend keys first." }
if (-not $SkipNeo4j) { docker compose up -d neo4j }
python -m alembic upgrade head

$RunDir = Join-Path $ProjectRoot ".local-run"
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$Backend = Start-Process -FilePath "python" -ArgumentList @("-m", "uvicorn", "backend.app.main:app", "--host", "127.0.0.1", "--port", "8000", "--workers", "1") -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
$Frontend = Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev", "--", "--host", "127.0.0.1") -WorkingDirectory (Join-Path $ProjectRoot "frontend") -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $RunDir "backend.pid") -Value $Backend.Id
Set-Content -LiteralPath (Join-Path $RunDir "frontend.pid") -Value $Frontend.Id
Write-Host "Started http://127.0.0.1:5173 (backend PID $($Backend.Id), frontend PID $($Frontend.Id))"
