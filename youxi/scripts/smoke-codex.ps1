# 真 CLI 冒烟（PRD 8.2：发版前跑一次真 CLI）：
# 用本机真实 codex CLI 验证 ①kind=tool 任务端到端 ②长文本任务被强制改路 api（不落 codex）。
# 前置：PATH 里有 codex（npm 版 .cmd 即可，doctor 会做 cmd shim），~/.codex 已登录。
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$port = 14401
$base = "http://127.0.0.1:$port"
$dataDir = Join-Path $env:TEMP "mica-smoke-codex-$PID"
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue

cargo build -p mica --features server 2>&1 | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { throw "build failed" }

$proc = Start-Process -FilePath (Join-Path $repo "target\debug\mica-server.exe") -PassThru -WindowStyle Hidden -Environment @{
    MICA_DATA_DIR = $dataDir
    MICA_PORT     = "$port"
}
try {
    foreach ($i in 1..30) {
        try { if ((Invoke-WebRequest "$base/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq "ok") { break } }
        catch { Start-Sleep -Milliseconds 300 }
    }

    Write-Host "== 用例 1：长文本任务指定 codex → 必须被改路 api =="
    $r = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" `
        -Body (@{ engine = "codex"; kind = "text"; prompt = "写一篇长文……" } | ConvertTo-Json)
    if ($r.engine -ne "api" -or -not $r.rerouted) { throw "text 任务应改路 api，实际 engine=$($r.engine)" }
    Write-Host "改路生效：codex(text) → $($r.engine)，rerouted=$($r.rerouted)" -ForegroundColor Green
    Invoke-WebRequest -Method Post -Uri "$base/v1/tasks/$($r.task_id)/cancel" -UseBasicParsing | Out-Null

    Write-Host "== 用例 2：真 codex 跑 tool 任务端到端 =="
    $r2 = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" `
        -Body (@{ engine = "codex"; kind = "tool"; prompt = "只回复两个字：好的" } | ConvertTo-Json)
    if ($r2.engine -ne "codex") { throw "tool 任务应留在 codex" }
    Write-Host "task_id=$($r2.task_id) engine=$($r2.engine)"
    # codex 首启可能有模型列表刷新超时（~60s stderr 噪音），放宽到 240s
    $state = ""
    foreach ($i in 1..240) {
        $t = Invoke-RestMethod "$base/v1/tasks/$($r2.task_id)"
        $state = $t.state
        if ($state -in @("done", "error", "canceled")) { break }
        if ($i % 15 -eq 0) { Write-Host "  ...${i}s state=$state" }
        Start-Sleep -Seconds 1
    }
    if ($state -ne "done") { throw "codex 任务 state=$state（期望 done）；result=$($t.result)" }
    Write-Host "codex 完成，result=「$($t.result)」" -ForegroundColor Green

    $sse = (& curl.exe -s -N -m 8 "$base/v1/tasks/$($r2.task_id)/events") -join "`n"
    foreach ($needle in @('"type":"started"', '"type":"delta"', '"type":"usage"', '"type":"done"')) {
        if ($sse -notmatch [regex]::Escape($needle)) { throw "codex SSE 缺少 $needle" }
    }
    Write-Host "SSE 事件完整（started/delta/usage/done）" -ForegroundColor Green

    $leftover = Get-Process codex -ErrorAction SilentlyContinue
    if ($leftover) { throw "残留 codex 进程：$($leftover.Id -join ',')" }
    Write-Host ""
    Write-Host "CODEX SMOKE PASS：改路策略 + 真 CLI 端到端 + 零残留" -ForegroundColor Green
}
finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Get-Process codex -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
}
