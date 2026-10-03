$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunDir = Join-Path $ProjectRoot ".local-run"
foreach ($Name in @("backend", "frontend")) {
  $PidFile = Join-Path $RunDir "$Name.pid"
  if (Test-Path -LiteralPath $PidFile) {
    $ProcessId = [int](Get-Content -LiteralPath $PidFile)
    Stop-Process -Id $ProcessId -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PidFile -Force
  }
}

# A manually launched `npm run dev` does not create .local-run/frontend.pid.
# Only terminate a listener whose command line belongs to this workspace; do
# not touch an unrelated Node process or a Docker-published port.
$FrontendRoot = (Resolve-Path (Join-Path $ProjectRoot "frontend")).Path
try {
  $listeners = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction Stop |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($ListenerPid in $listeners) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ListenerPid" -ErrorAction SilentlyContinue
    if ($null -ne $processInfo -and
        $processInfo.Name -eq "node.exe" -and
        $processInfo.CommandLine -like "*$FrontendRoot*vite*" ) {
      Stop-Process -Id $ListenerPid -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped workspace Vite process PID $ListenerPid (port 5173)."
    }
  }
} catch {
  Write-Warning "Could not inspect port 5173: $($_.Exception.Message)"
}

$remaining = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if ($remaining) {
  Write-Warning "Port 5173 is still in use. Run 'netstat -ano | findstr :5173' and inspect the owning process."
} else {
  Write-Host "Local backend/frontend stopped. Use 'docker compose stop neo4j' to stop Neo4j."
}
