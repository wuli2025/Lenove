# 端到端冒烟（PRD 8.2）：mock CLI 回放 stream-json，验证
# 提交 → SSE 流（Delta/Done/StateChanged）→ 取消（4.8 控制通道）→ 410 幂等 → 零残留进程。
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$port = 14400
$base = "http://127.0.0.1:$port"
$dataDir = Join-Path $env:TEMP "mica-smoke-$PID"
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue

Write-Host "== 构建 =="
cargo build -p mica --features server 2>&1 | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { throw "build failed" }

$serverExe = Join-Path $repo "target\debug\mica-server.exe"
$mockExe = Join-Path $repo "target\debug\mock-claude.exe"

Write-Host "== 起服（mock CLI）=="
$proc = Start-Process -FilePath $serverExe -PassThru -WindowStyle Hidden -Environment @{
    MICA_DATA_DIR   = $dataDir
    MICA_PORT       = "$port"
    MICA_CLAUDE_EXE = $mockExe
}
try {
    # 等健康检查
    $ready = $false
    foreach ($i in 1..30) {
        try {
            if ((Invoke-WebRequest "$base/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq "ok") { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 300 }
    }
    if (-not $ready) { throw "server not ready" }
    Write-Host "healthz: ok" -ForegroundColor Green

    Write-Host "== 用例 1：提交 claude 任务，SSE 收到 Delta 与 Done =="
    $resp = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" `
        -Body (@{ engine = "claude"; prompt = "冒烟测试你好" } | ConvertTo-Json)
    $taskId = $resp.task_id
    Write-Host "task_id=$taskId position=$($resp.position)"

    # 轮询到终态
    $state = ""
    foreach ($i in 1..40) {
        $t = Invoke-RestMethod "$base/v1/tasks/$taskId"
        $state = $t.state
        if ($state -in @("done", "error", "canceled")) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($state -ne "done") { throw "task state=$state, expected done" }
    if (-not $t.result.Contains("mock")) { throw "result 应包含 mock 回复: $($t.result)" }
    Write-Host "任务完成，result 长度 $($t.result.Length)" -ForegroundColor Green

    # SSE 回放（终态任务：全量事件后流关闭）
    $sse = (& curl.exe -s -N -m 8 "$base/v1/tasks/$taskId/events") -join "`n"
    foreach ($needle in @('"type":"queued"', '"type":"started"', '"type":"delta"', '"type":"usage"', '"type":"done"', '"state":"done"')) {
        if ($sse -notmatch [regex]::Escape($needle)) { throw "SSE 回放缺少 $needle" }
    }
    Write-Host "SSE 回放完整（queued/started/delta/usage/done/state_changed）" -ForegroundColor Green

    # Last-Event-ID 续传：从 seq=3 之后拉，应少于全量
    $partial = (& curl.exe -s -N -m 8 -H "Last-Event-ID: 3" "$base/v1/tasks/$taskId/events") -join "`n"
    if ($partial.Length -ge $sse.Length) { throw "Last-Event-ID 续传应少于全量回放" }
    Write-Host "Last-Event-ID 续传生效" -ForegroundColor Green

    Write-Host "== 用例 2：挂起任务 → cancel → 毫秒级杀树 → 410 幂等 =="
    $resp2 = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" `
        -Body (@{ engine = "claude"; prompt = "MOCK_HANG 请挂起" } | ConvertTo-Json)
    $hangId = $resp2.task_id
    # 等它进入 running
    foreach ($i in 1..40) {
        $s = (Invoke-RestMethod "$base/v1/tasks/$hangId").state
        if ($s -eq "running") { break }
        Start-Sleep -Milliseconds 200
    }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $cancelResp = Invoke-WebRequest -Method Post -Uri "$base/v1/tasks/$hangId/cancel" -UseBasicParsing
    if ($cancelResp.StatusCode -ne 202) { throw "cancel 应 202" }
    foreach ($i in 1..40) {
        $s = (Invoke-RestMethod "$base/v1/tasks/$hangId").state
        if ($s -eq "canceled") { break }
        Start-Sleep -Milliseconds 100
    }
    $sw.Stop()
    if ($s -ne "canceled") { throw "cancel 后 state=$s" }
    Write-Host "取消端到端 $($sw.ElapsedMilliseconds)ms（含轮询间隔）" -ForegroundColor Green

    # SSE 应含 control_ack 与 canceled
    $sse2 = (& curl.exe -s -N -m 8 "$base/v1/tasks/$hangId/events") -join "`n"
    foreach ($needle in @('"type":"control_ack"', '"op":"cancel"', '"state":"canceled"')) {
        if ($sse2 -notmatch [regex]::Escape($needle)) { throw "取消任务 SSE 缺少 $needle" }
    }
    Write-Host "控制回执闭环（ControlAck + StateChanged 走 SSE）" -ForegroundColor Green

    # 终态幂等：再 cancel → 410
    try {
        Invoke-WebRequest -Method Post -Uri "$base/v1/tasks/$hangId/cancel" -UseBasicParsing | Out-Null
        throw "对已终态任务 cancel 应 410"
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code -ne 410) { throw "期望 410，实际 $code" }
    }
    Write-Host "终态幂等：重复 cancel → 410" -ForegroundColor Green

    Write-Host "== 用例 3：/metrics 暴露调度指标 =="
    $metrics = (Invoke-WebRequest "$base/metrics" -UseBasicParsing).Content
    if ($metrics -notmatch "mica_cli_slots_free") { throw "metrics 缺字段" }
    Write-Host "metrics OK" -ForegroundColor Green

    Write-Host "== 用例 4：杀树零残留 =="
    $leftover = Get-Process mock-claude -ErrorAction SilentlyContinue
    if ($leftover) { throw "存在残留 mock-claude 进程：$($leftover.Id -join ',')" }
    Write-Host "无残留子进程" -ForegroundColor Green

    Write-Host ""
    Write-Host "SMOKE PASS：提交/流式/回放/续传/取消/回执/幂等/指标/零残留 全部通过" -ForegroundColor Green
}
finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Get-Process mock-claude -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
}
