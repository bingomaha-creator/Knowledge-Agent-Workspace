# E2E check: simulate the frontend "SSE + 2s polling" behavior against one real run.
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 parses .ps1 as ANSI).
$ErrorActionPreference = "Stop"
$base = "http://localhost:8000/api/v1"
$terminal = @("completed", "failed", "cancelled", "budget_exhausted")

# 1. Create session
$session = Invoke-RestMethod -Method Post -Uri "$base/sessions" -ContentType "application/json" -Body '{"title":"E2E poll verification"}'
Write-Output "[step1] session=$($session.session_id)"

# 2. Send message (starts a run)
$body = @{ client_message_id = [guid]::NewGuid().ToString(); content = "What are the key features of modern open-source RAG agent frameworks? Summarize in Chinese."; source_mode = "web"; workflow_mode = "deep_research" } | ConvertTo-Json -Compress
$resp = Invoke-RestMethod -Method Post -Uri "$base/sessions/$($session.session_id)/messages" -ContentType "application/json" -Body $body
$runId = $resp.run_id
Write-Output "[step2] run=$runId"

# 3. Capture SSE stream for the first 8 seconds (EventSource equivalent)
$sse = Start-Job -ScriptBlock { param($u) & curl.exe -s -N --max-time 8 "$u" } -ArgumentList "$base/runs/$runId/events"
Start-Sleep -Seconds 8
$sseLines = Receive-Job $sse -Wait
Remove-Job $sse -Force
Write-Output "[step3] sse_lines=$($sseLines.Count)"
$sseLines | Select-Object -First 14 | ForEach-Object { Write-Output "  $_" }

# 4. Poll every 2s until terminal state (matches RUN_POLL_MS)
$maxPolls = 180
for ($i = 0; $i -lt $maxPolls; $i++) {
  Start-Sleep -Seconds 2
  $run = Invoke-RestMethod -Method Get -Uri "$base/runs/$runId"
  $usage = if ($run.usage.usage) { " tools=$($run.usage.usage.tool_calls) llm=$($run.usage.usage.llm_tokens) elapsed=$($run.usage.usage.elapsed_seconds)s" } else { "" }
  Write-Output "[poll$i] status=$($run.status) stage=$($run.current_stage)$usage"
  if ($terminal -contains $run.status) { break }
}
if (-not ($terminal -contains $run.status)) { Write-Output "[fail] no terminal state within $maxPolls polls"; exit 1 }

# 5. Evidence + report with verification array
$ev = Invoke-RestMethod -Method Get -Uri "$base/runs/$runId/evidence"
Write-Output "[step5] evidence_count=$($ev.items.Count)"
$ev.items | Select-Object -First 3 | ForEach-Object { Write-Output "  [$($_.source_mode)] $($_.title) score=$($_.score)" }
$report = Invoke-RestMethod -Method Get -Uri "$base/runs/$runId/report"
$pass = @($report.verification | Where-Object { $_.passed -eq $true }).Count
$fail = @($report.verification | Where-Object { $_.passed -ne $true }).Count
Write-Output "[step5] report_chars=$($report.content.Length) verification_total=$($report.verification.Count) pass=$pass fail=$fail"
$report.verification | ForEach-Object { Write-Output "  $($_.kind): passed=$($_.passed)" }
Write-Output "[done] status=$($run.status)"
