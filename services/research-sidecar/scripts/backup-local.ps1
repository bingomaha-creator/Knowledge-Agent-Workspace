param([string]$Archive = "", [switch]$IncludeNeo4j)
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $ProjectRoot
if (-not $Archive) { $Archive = Join-Path $ProjectRoot ("backups\local-mvp-{0}.zip" -f (Get-Date -Format "yyyyMMdd-HHmmss")) }
if ($IncludeNeo4j) {
  docker compose stop neo4j
  try {
    docker compose run --rm neo4j neo4j-admin database dump neo4j --to-path=/backups --overwrite-destination=true
    docker compose cp neo4j:/backups/neo4j.dump data/neo4j.dump
  } finally { docker compose start neo4j }
}
python scripts/backup_restore.py backup --archive $Archive
