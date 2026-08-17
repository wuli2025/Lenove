# 验证「纯 Rust 直连生成」这条腿：不 spawn 任何 CLI、不碰 Python，
# ApiEngine 自己说 HTTP+SSE 把内容生成出来。真供应商（MiniMax anthropic 兼容网关）。
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$key = (Get-Content "D:\polaris\爱聊小助手\config.json" -Raw | ConvertFrom-Json).apiKey
$dataDir = Join-Path $env:TEMP "mica-api-verify-$PID"
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
$port = 14701; $base = "http://127.0.0.1:$port"

$proc = Start-Process -FilePath (Join-Path $repo "target\release\mica-server.exe") -PassThru -WindowStyle Hidden `
    -Environment @{ MICA_DATA_DIR = $dataDir; MICA_PORT = "$port"; RUST_LOG = "warn" }
foreach ($i in 1..40) {
    try { if ((Invoke-WebRequest "$base/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq "ok") { break } } catch { Start-Sleep -Milliseconds 300 }
}

try {
    Write-Host "== 1. 加供应商（预设 minimax，只填 key）==" -ForegroundColor Cyan
    Invoke-RestMethod -Method Post -Uri "$base/v1/providers" -ContentType "application/json" `
        -Body (@{ id = "mm"; preset = "minimax"; secret = $key } | ConvertTo-Json) | ConvertTo-Json -Compress

    Write-Host "== 2. 探测预检 + 激活（预检不过不给切）==" -ForegroundColor Cyan
    $probe = Invoke-RestMethod -Method Post -Uri "$base/v1/providers/mm/probe"
    Write-Host "probe: $($probe | ConvertTo-Json -Compress)"
    $act = Invoke-RestMethod -Method Post -Uri "$base/v1/providers/mm/activate"
    Write-Host "activate: $($act | ConvertTo-Json -Compress)"

    Write-Host "== 3. 纯 Rust 直连生成（engine=api，全程零子进程）==" -ForegroundColor Cyan
    $before = @(Get-Process codex*, claude*, python*, node* -ErrorAction SilentlyContinue).Count
    $r = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" -Body (@{
            engine = "api"; kind = "text"; tenant = "verify"
            prompt = "用中文写一段 80 字左右的水墨风格场景描写：雨后的青石巷。只输出正文。"
        } | ConvertTo-Json)
    Write-Host "提交：engine=$($r.engine) rerouted=$($r.rerouted)"

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $maxChild = 0
    while ($sw.Elapsed.TotalSeconds -lt 120) {
        $n = @(Get-Process codex*, claude*, python* -ErrorAction SilentlyContinue).Count
        if ($n -gt $maxChild) { $maxChild = $n }
        $t = Invoke-RestMethod "$base/v1/tasks/$($r.task_id)"
        if ($t.state -in @("done", "error", "canceled")) { break }
        Start-Sleep -Milliseconds 400
    }
    Write-Host "`nstate=$($t.state)  耗时=$([math]::Round($sw.Elapsed.TotalSeconds,1))s  期间 CLI/Python 子进程数=$maxChild" -ForegroundColor Yellow
    Write-Host "--- 生成正文 ---" -ForegroundColor Green
    Write-Host $t.result

    Write-Host "`n== 4. SSE 事件流（Rust 自己解的 SSE）==" -ForegroundColor Cyan
    $ev = (& curl.exe -s -N -m 6 "$base/v1/tasks/$($r.task_id)/events") -join "`n"
    Write-Host (($ev -split "`n" | Select-Object -First 8) -join "`n")

    Write-Host "`n== 5. 并发 8 个 api 任务（api 池 512，与 CLI 池互不挤占）==" -ForegroundColor Cyan
    $ids = @()
    foreach ($i in 1..8) {
        $x = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" -Body (@{
                engine = "api"; kind = "text"; tenant = "c$($i % 4)"; prompt = "用一句话说明数字 $i 的一个数学性质。只输出一句话。"
            } | ConvertTo-Json)
        $ids += $x.task_id
    }
    $sw2 = [Diagnostics.Stopwatch]::StartNew()
    $st = @{}
    while ($sw2.Elapsed.TotalSeconds -lt 120) {
        $pending = 0
        foreach ($id in $ids) {
            if ($st[$id] -in @("done", "error", "canceled")) { continue }
            $st[$id] = (Invoke-RestMethod "$base/v1/tasks/$id").state
            if ($st[$id] -notin @("done", "error", "canceled")) { $pending++ }
        }
        if ($pending -eq 0) { break }
        Start-Sleep -Milliseconds 400
    }
    $doneN = @($st.Values | Where-Object { $_ -eq "done" }).Count
    Write-Host "8 并发 api 任务：done $doneN/8，耗时 $([math]::Round($sw2.Elapsed.TotalSeconds,1))s" -ForegroundColor Yellow
    foreach ($id in ($ids | Select-Object -First 3)) {
        Write-Host "  · $((Invoke-RestMethod "$base/v1/tasks/$id").result -replace "`n",' ')"
    }
    $srv = Get-Process -Id $proc.Id
    Write-Host "服务 RSS=$([math]::Round($srv.WorkingSet64/1MB,1))MB" -ForegroundColor DarkGray
}
finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
}
