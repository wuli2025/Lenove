# codex 深度测试（真 CLI）：并发槽位隔离 / 产物事件 / 真生图 / 运行中取消杀树。
# 前置：PATH 有 codex，~/.codex 已登录。生图用例走真模型，整脚本预算 ~5 分钟。
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$port = 14402
$base = "http://127.0.0.1:$port"
$dataDir = Join-Path $env:TEMP "mica-codex-deep-$PID"
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue

cargo build -p mica --features server 2>&1 | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { throw "build failed" }

$proc = Start-Process -FilePath (Join-Path $repo "target\debug\mica-server.exe") -PassThru -WindowStyle Hidden -Environment @{
    MICA_DATA_DIR = $dataDir
    MICA_PORT     = "$port"
}

function Wait-Task($id, $seconds) {
    foreach ($i in 1..$seconds) {
        $t = Invoke-RestMethod "$base/v1/tasks/$id"
        if ($t.state -in @("done", "error", "canceled")) { return $t }
        Start-Sleep -Seconds 1
    }
    return $t
}

try {
    foreach ($i in 1..30) {
        try { if ((Invoke-WebRequest "$base/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq "ok") { break } }
        catch { Start-Sleep -Milliseconds 300 }
    }

    Write-Host "== 用例 A：并发 2 个 codex 任务（槽位 CODEX_HOME 隔离）=="
    $a1 = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" `
        -Body (@{ engine = "codex"; kind = "tool"; tenant = "u1"; prompt = "在当前目录创建 a.txt，内容写：甲。只做这一件事。" } | ConvertTo-Json)
    $a2 = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" `
        -Body (@{ engine = "codex"; kind = "tool"; tenant = "u2"; prompt = "在当前目录创建 b.txt，内容写：乙。只做这一件事。" } | ConvertTo-Json)
    $t1 = Wait-Task $a1.task_id 240
    $t2 = Wait-Task $a2.task_id 240
    if ($t1.state -ne "done" -or $t2.state -ne "done") { throw "并发任务未全部完成：$($t1.state)/$($t2.state)" }
    $f1 = Join-Path $dataDir "workspaces\u1\$($a1.task_id)\a.txt"
    $f2 = Join-Path $dataDir "workspaces\u2\$($a2.task_id)\b.txt"
    if (-not (Test-Path $f1) -or -not (Test-Path $f2)) { throw "工作区产物缺失（租户隔离目录）" }
    $slots = (Get-ChildItem (Join-Path $dataDir "codex-home") -Directory).Count
    if ($slots -lt 2) { throw "并发应使用 >=2 个独立 CODEX_HOME 槽位，实际 $slots" }
    Write-Host "并发 2 任务完成，租户工作区各自落盘，槽位数=$slots" -ForegroundColor Green

    # 产物事件断言：file_change → artifact
    $sseA = (& curl.exe -s -N -m 8 "$base/v1/tasks/$($a1.task_id)/events") -join "`n"
    if ($sseA -notmatch [regex]::Escape('"type":"artifact"')) { throw "SSE 缺 artifact 事件" }
    if ($sseA -notmatch [regex]::Escape('a.txt')) { throw "artifact 应含 a.txt 路径" }
    Write-Host "Artifact 事件回传（file_change → artifact）" -ForegroundColor Green

    Write-Host "== 用例 B：真生图任务（kind=image，codex 主战场）=="
    $b = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" `
        -Body (@{ engine = "api"; kind = "image"; prompt = "用你的图像生成能力生成一张简约水墨山水画，保存为当前目录下的 shanshui.png。只做这一件事。" } | ConvertTo-Json)
    if ($b.engine -ne "codex" -or -not $b.rerouted) { throw "image 任务应改路 codex，实际 $($b.engine)" }
    Write-Host "改路生效：api(image) → codex；生图中（真模型，最长等 300s）..."
    $tb = Wait-Task $b.task_id 300
    if ($tb.state -ne "done") { throw "生图任务 state=$($tb.state)；result=$($tb.result)" }
    $png = Get-ChildItem (Join-Path $dataDir "workspaces\default\$($b.task_id)") -Filter *.png -ErrorAction SilentlyContinue
    if (-not $png) { throw "工作区无 PNG 产物" }
    $sseB = (& curl.exe -s -N -m 8 "$base/v1/tasks/$($b.task_id)/events") -join "`n"
    if ($sseB -notmatch [regex]::Escape('"kind":"image"')) { throw "SSE 缺 image 类 artifact 事件" }
    Write-Host "生图完成：$($png.Name)（$([math]::Round($png.Length/1KB))KB），Artifact(kind=image) 事件已回传" -ForegroundColor Green

    Write-Host "== 用例 C：运行中取消 codex → Job Object 杀树零残留 =="
    $c = Invoke-RestMethod -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" `
        -Body (@{ engine = "codex"; kind = "tool"; prompt = "运行一个等待 300 秒的命令（PowerShell Start-Sleep 300），等它结束后回复完成。" } | ConvertTo-Json)
    foreach ($i in 1..60) {
        $s = (Invoke-RestMethod "$base/v1/tasks/$($c.task_id)").state
        if ($s -eq "running") { break }
        Start-Sleep -Seconds 1
    }
    Start-Sleep -Seconds 8  # 给 codex 时间真正把 sleep 命令跑起来（产生子进程树）
    Invoke-WebRequest -Method Post -Uri "$base/v1/tasks/$($c.task_id)/cancel" -UseBasicParsing | Out-Null
    $tc = Wait-Task $c.task_id 20
    if ($tc.state -ne "canceled") { throw "取消后 state=$($tc.state)" }
    Start-Sleep -Seconds 2
    $leftover = Get-Process codex -ErrorAction SilentlyContinue
    if ($leftover) { throw "残留 codex 进程树：$($leftover.Id -join ',')" }
    Write-Host "运行中取消 → canceled，进程树零残留" -ForegroundColor Green

    Write-Host ""
    Write-Host "CODEX DEEP PASS：并发槽位隔离 / Artifact 事件 / 真生图 / 杀树取消 全部通过" -ForegroundColor Green
}
finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Get-Process codex -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
}
