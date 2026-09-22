param([Parameter(Mandatory=$true)][string]$Archive, [switch]$RestoreNeo4j)
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ResolvedArchive = (Resolve-Path -LiteralPath $Archive).Path
Set-Location -LiteralPath $ProjectRoot
python scripts/backup_restore.py restore --archive $ResolvedArchive --confirm
if ($RestoreNeo4j -and (Test-Path -LiteralPath "data/neo4j.dump")) {
  docker compose stop neo4j
  try {
    docker compose cp data/neo4j.dump neo4j:/backups/neo4j.dump
    docker compose run --rm neo4j neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true
  } finally { docker compose start neo4j }
}
