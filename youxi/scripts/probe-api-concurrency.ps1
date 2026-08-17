# 取证：verify-api-engine 里「8 并发只成 3」的根因——是真供应商限流，还是基座自己的问题？
# 逐任务打印 state + result 原文，并对照单发成功率。
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$key = (Get-Content "D:\polaris\爱聊小助手\config.json" -Raw | ConvertFrom-Json).apiKey
$dataDir = Join-Path $env:TEMP "mica-apiconc-$PID"
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
$port = 14702; $base = "http://127.0.0.1:$port"

$proc = Start-Process -FilePath (Join-Path $repo "target\release\mica-server.exe") -PassThru -WindowStyle Hidden `
    -Environment @{ MICA_DATA_DIR = $dataDir; MICA_PORT = "$port"; RUST_LOG = "warn" }
foreach ($i in 1..40) {
    try { if ((Invoke-WebRequest "$base/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq "ok") { break } } catch { Start-Sleep -Milliseconds 300 }
}

function Run-Batch($n, $label) {
    $ids = @()
    foreach ($i in 1..$n) {
        $x = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" -Body (@{
                engine = "api"; kind = "text"; tenant = "b$i"; prompt = "用一句话说明数字 $i 的一个数学性质。只输出一句话。"
            } | ConvertTo-Json)
        $ids += $x.task_id
    }
    $st = @{}
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt 150) {
        $pending = 0
        foreach ($id in $ids) {
            if ($st[$id] -in @("done", "error", "canceled")) { continue }
            $st[$id] = (Invoke-RestMethod "$base/v1/tasks/$id").state
            if ($st[$id] -notin @("done", "error", "canceled")) { $pending++ }
        }
        if ($pending -eq 0) { break }
        Start-Sleep -Milliseconds 400
    }
    Write-Host "`n===== $label（$n 个）耗时 $([math]::Round($sw.Elapsed.TotalSeconds,1))s =====" -ForegroundColor Cyan
    $emptyDone = 0
    foreach ($id in $ids) {
        $t = Invoke-RestMethod "$base/v1/tasks/$id"
        $res = "$($t.result)".Trim()
        if ($t.state -eq "done" -and $res.Length -eq 0) { $emptyDone++ }
        $short = if ($res.Length -gt 90) { $res.Substring(0, 90) + "…" } else { $res }
        $color = switch ($t.state) { "done" { if ($res.Length -eq 0) { "Yellow" } else { "Green" } } default { "Red" } }
        Write-Host ("  [{0,-6}] len={1,-4} {2}" -f $t.state, $res.Length, ($short -replace "`n", " ")) -ForegroundColor $color
    }
    $doneN = @($ids | Where-Object { $st[$_] -eq "done" }).Count
    Write-Host ("  小结：done {0}/{1}，其中空正文 {2} 个" -f $doneN, $n, $emptyDone) -ForegroundColor Yellow
    return @{ Done = $doneN; Empty = $emptyDone; N = $n }
}

try {
    Invoke-RestMethod -Method Post -Uri "$base/v1/providers" -ContentType "application/json" `
        -Body (@{ id = "mm"; preset = "minimax"; secret = $key } | ConvertTo-Json) | Out-Null
    Invoke-RestMethod -Method Post -Uri "$base/v1/providers/mm/activate" | Out-Null

    $seq = Run-Batch 3 "对照组：低并发"
    Start-Sleep -Seconds 5
    $conc = Run-Batch 8 "实验组：8 并发"

    Write-Host "`n===== 结论 =====" -ForegroundColor Cyan
    Write-Host "低并发 done $($seq.Done)/$($seq.N)（空 $($seq.Empty)）  vs  8 并发 done $($conc.Done)/$($conc.N)（空 $($conc.Empty)）"
    Write-Host "`n服务端 warn 日志见控制台；下面直接裸打 MiniMax 网关做旁证（绕开基座）：" -ForegroundColor Cyan
    $body = @{ model = "MiniMax-M2"; max_tokens = 64; messages = @(@{ role = "user"; content = "说一句话" }) } | ConvertTo-Json -Depth 5
    $jobs = 1..8 | ForEach-Object {
        Start-ThreadJob -ScriptBlock {
            param($k, $b)
            try {
                $r = Invoke-WebRequest -Method Post -Uri "https://api.minimaxi.com/anthropic/v1/messages" `
                    -Headers @{ "Authorization" = "Bearer $k"; "anthropic-version" = "2023-06-01" } `
                    -ContentType "application/json" -Body $b -UseBasicParsing -TimeoutSec 60
                "HTTP $($r.StatusCode)"
            }
            catch { "ERR $($_.Exception.Message -replace "`n",' ')" }
        } -ArgumentList $key, $body
    }
    $jobs | Wait-Job -Timeout 90 | Out-Null
    $raw = $jobs | Receive-Job
    Remove-Job $jobs -Force
    Write-Host "裸打网关 8 并发结果：" -ForegroundColor Yellow
    $raw | Group-Object | ForEach-Object { Write-Host "  $($_.Count) × $($_.Name)" }
}
finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
}
