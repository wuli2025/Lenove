# 定点复现：S1 洪峰里 1/36 任务 error 的根因取证。
# 与 stress 不同——不删数据目录，把失败任务的 result / stderr / 工作区原样留证。
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$N = 12; $Slots = 6
$dataDir = Join-Path $env:TEMP "mica-probe-$PID"
$port = 14601; $base = "http://127.0.0.1:$port"
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath (Join-Path $repo "target\release\mica-server.exe") -PassThru -WindowStyle Hidden `
    -Environment @{ MICA_DATA_DIR = $dataDir; MICA_PORT = "$port"; MICA_CLI_SLOTS = "$Slots"; RUST_LOG = "info" } `
    -RedirectStandardError (Join-Path $env:TEMP "mica-probe-server-$PID.log")
foreach ($i in 1..40) {
    try { if ((Invoke-WebRequest "$base/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq "ok") { break } } catch { Start-Sleep -Milliseconds 300 }
}

try {
    $ids = @()
    foreach ($i in 1..$N) {
        $r = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" -Body (@{
                engine = "codex"; kind = "tool"; tenant = "p$($i % 3)"
                prompt = "把 PROBE-$i 写入当前目录的 out.txt，只做这一件事。"
            } | ConvertTo-Json)
        $ids += $r.task_id
    }
    Write-Host "$N 个任务已入队（slots=$Slots），等待..." -ForegroundColor Cyan

    $states = @{}
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalMinutes -lt 12) {
        $pending = 0
        foreach ($id in $ids) {
            if ($states[$id] -in @("done", "error", "canceled")) { continue }
            $states[$id] = (Invoke-RestMethod "$base/v1/tasks/$id").state
            if ($states[$id] -notin @("done", "error", "canceled")) { $pending++ }
        }
        if ($pending -eq 0) { break }
        Start-Sleep -Seconds 2
    }

    $fails = @($ids | Where-Object { $states[$_] -ne "done" })
    Write-Host "`n结果：done $(($ids | Where-Object { $states[$_] -eq 'done' }).Count)/$N，失败 $($fails.Count)" -ForegroundColor Cyan
    foreach ($id in $fails) {
        $t = Invoke-RestMethod "$base/v1/tasks/$id"
        Write-Host "`n--- 失败任务 $id（state=$($t.state)）---" -ForegroundColor Red
        Write-Host "result: $($t.result)"
        $ev = (& curl.exe -s -N -m 6 "$base/v1/tasks/$id/events") -join "`n"
        Write-Host "事件流尾部：`n$($ev -split "`n" | Select-Object -Last 12 | Out-String)"
    }
    if ($fails.Count -eq 0) { Write-Host "本轮 $N 个全过（上轮 1/36 error 未复现）" -ForegroundColor Green }
    Write-Host "`n数据目录留证：$dataDir"
    Write-Host "服务端日志：$(Join-Path $env:TEMP "mica-probe-server-$PID.log")"
}
finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Get-Process codex* -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
