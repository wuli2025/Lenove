# 回答「不行的话能不能调 python 生成」：不改基座，让 codex 任务在工作区里跑 python 产出产物。
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$dataDir = Join-Path $env:TEMP "mica-pypath-$PID"
$port = 14705
$base = "http://127.0.0.1:$port"
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath (Join-Path $repo "target\release\mica-server.exe") -PassThru -WindowStyle Hidden `
    -Environment @{ MICA_DATA_DIR = $dataDir; MICA_PORT = "$port"; RUST_LOG = "warn" }
foreach ($i in 1..40) {
    try { if ((Invoke-WebRequest "$base/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq "ok") { break } } catch { Start-Sleep -Milliseconds 300 }
}

try {
    $r = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" -Body (@{
            engine = "codex"; kind = "tool"; tenant = "py"
            prompt = "用 python 写一个脚本 gen.py，算出 1 到 50 之间的所有质数，写进 primes.txt（逗号分隔）。然后运行它。只做这件事。"
        } | ConvertTo-Json)

    $sw = [Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Seconds 2
        $t = Invoke-RestMethod "$base/v1/tasks/$($r.task_id)"
    } while ($t.state -notin @("done", "error", "canceled") -and $sw.Elapsed.TotalSeconds -lt 220)

    Write-Host "state=$($t.state)  耗时=$([math]::Round($sw.Elapsed.TotalSeconds,1))s" -ForegroundColor Yellow
    $ws = Join-Path $dataDir "workspaces\py\$($r.task_id)"
    Write-Host "`n=== 工作区产物 ===" -ForegroundColor Cyan
    Get-ChildItem $ws -ErrorAction SilentlyContinue | Select-Object Name, Length | Format-Table -AutoSize | Out-String | Write-Host

    $pf = Join-Path $ws "primes.txt"
    if (Test-Path $pf) {
        Write-Host "=== primes.txt 内容 ===" -ForegroundColor Green
        Get-Content $pf -Raw | Write-Host
        $want = "2,3,5,7,11,13,17,19,23,29,31,37,41,43,47"
        $got = ((Get-Content $pf -Raw) -replace '\s', '')
        Write-Host ("正确性：{0}" -f $(if ($got -eq $want) { "✓ 与期望完全一致" } else { "✗ 期望 $want" })) -ForegroundColor $(if ($got -eq $want) { "Green" } else { "Red" })
    }
    else { Write-Host "primes.txt 未生成" -ForegroundColor Red }

    $ev = (& curl.exe -s -N -m 5 "$base/v1/tasks/$($r.task_id)/events") -join "`n"
    $arts = ($ev -split "`n") | Where-Object { $_ -match '"type":"artifact"' }
    Write-Host "`n=== Artifact 事件（基座回传的产物）===" -ForegroundColor Cyan
    $arts | Select-Object -First 4 | ForEach-Object { Write-Host "  $_" }
}
finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Get-Process codex* -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
}
