# 抓 ApiEngine 失败的错误原文 + 裸网关「流式 vs 非流式」对照。
# 关键对照：基座用 stream:true + max_tokens:8192，旁证裸打之前用的是非流式 + 64。
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$key = (Get-Content "D:\polaris\爱聊小助手\config.json" -Raw | ConvertFrom-Json).apiKey

Write-Host "===== A. 裸网关对照（绕开基座，直接打 MiniMax）=====" -ForegroundColor Cyan
function Bare($label, $stream, $maxTok) {
    $body = @{ model = "MiniMax-M2"; max_tokens = $maxTok; stream = $stream
        messages = @(@{ role = "user"; content = "用一句话说明数字 7 的一个数学性质。" })
    } | ConvertTo-Json -Depth 5
    $f = Join-Path $env:TEMP "bare-$label.json"; Set-Content $f $body -Encoding utf8
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $out = & curl.exe -s -m 90 -w "`n__HTTP:%{http_code}__" -X POST "https://api.minimaxi.com/anthropic/v1/messages" `
        -H "Authorization: Bearer $key" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" `
        --data-binary "@$f"
    $joined = $out -join "`n"
    $code = if ($joined -match "__HTTP:(\d+)__") { $Matches[1] } else { "?" }
    Write-Host ("  {0,-28} HTTP {1}  {2}s  响应 {3} 字节" -f $label, $code, [math]::Round($sw.Elapsed.TotalSeconds, 1), $joined.Length) `
        -ForegroundColor $(if ($code -eq "200") { "Green" } else { "Red" })
    if ($code -ne "200") { Write-Host "    响应原文：$($joined.Substring(0,[Math]::Min(400,$joined.Length)))" -ForegroundColor DarkRed }
    Remove-Item $f -ErrorAction SilentlyContinue
    return $code
}
Bare "非流式 max_tokens=64" $false 64 | Out-Null
Bare "非流式 max_tokens=8192" $false 8192 | Out-Null
Bare "流式 stream=true mt=64" $true 64 | Out-Null
Bare "流式 stream=true mt=8192（=基座配置）" $true 8192 | Out-Null

Write-Host "`n===== B. 基座 ApiEngine 的错误原文（SSE 事件流）=====" -ForegroundColor Cyan
$dataDir = Join-Path $env:TEMP "mica-apierr-$PID"
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
$port = 14703; $base = "http://127.0.0.1:$port"
$proc = Start-Process -FilePath (Join-Path $repo "target\release\mica-server.exe") -PassThru -WindowStyle Hidden `
    -Environment @{ MICA_DATA_DIR = $dataDir; MICA_PORT = "$port"; RUST_LOG = "info" } `
    -RedirectStandardError (Join-Path $env:TEMP "mica-apierr-srv-$PID.log")
foreach ($i in 1..40) {
    try { if ((Invoke-WebRequest "$base/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq "ok") { break } } catch { Start-Sleep -Milliseconds 300 }
}
try {
    Invoke-RestMethod -Method Post -Uri "$base/v1/providers" -ContentType "application/json" `
        -Body (@{ id = "mm"; preset = "minimax"; secret = $key } | ConvertTo-Json) | Out-Null
    try { Invoke-RestMethod -Method Post -Uri "$base/v1/providers/mm/activate" | Out-Null }
    catch { Write-Host "  activate 被拒（探测未过）：$($_.ErrorDetails.Message)" -ForegroundColor DarkYellow }

    foreach ($round in 1..4) {
        $r = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" -Body (@{
                engine = "api"; kind = "text"; tenant = "e$round"; prompt = "用一句话说明数字 7 的一个数学性质。只输出一句话。"
            } | ConvertTo-Json)
        $sw = [Diagnostics.Stopwatch]::StartNew()
        do {
            Start-Sleep -Milliseconds 400
            $t = Invoke-RestMethod "$base/v1/tasks/$($r.task_id)"
        } while ($t.state -notin @("done", "error", "canceled") -and $sw.Elapsed.TotalSeconds -lt 120)
        $ev = (& curl.exe -s -N -m 5 "$base/v1/tasks/$($r.task_id)/events") -join "`n"
        $errLine = ($ev -split "`n" | Where-Object { $_ -match '"type":"(failed|error)"' }) -join " "
        Write-Host ("  第 $round 轮：state={0} 耗时={1}s" -f $t.state, [math]::Round($sw.Elapsed.TotalSeconds, 1)) `
            -ForegroundColor $(if ($t.state -eq "done") { "Green" } else { "Red" })
        if ($errLine) { Write-Host "    错误事件：$errLine" -ForegroundColor DarkRed }
    }
    Write-Host "`n  服务端日志尾部：" -ForegroundColor DarkGray
    Get-Content (Join-Path $env:TEMP "mica-apierr-srv-$PID.log") -Tail 12 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}
finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
}
