# 大规模强度测试（真 codex CLI）：并发洪峰 / 租户公平 / 混沌取消 / 背压 / 长稳泄漏。
# 与 test-codex-deep.ps1 的区别：那个验「功能通不通」，这个验「压到极限崩不崩」。
# 前置：PATH 有 codex 且 ~/.codex 已登录；须 pwsh 7 运行（中文注释 UTF-8）。
# 用法：pwsh -NoProfile -File scripts/stress-codex.ps1 -Phase all
param(
    [ValidateSet("all", "s1", "s2", "s3", "s4", "s5")]
    [string]$Phase = "all",
    # S1 洪峰规模（真 codex 调用数 = Tasks），按配额调小
    [int]$Tasks = 36,
    [int]$Slots = 6
)

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$script:results = [System.Collections.Generic.List[object]]::new()
function Assert-Ok($name, [bool]$ok, $detail) {
    $script:results.Add([pscustomobject]@{ Phase = $script:curPhase; Case = $name; Ok = $ok; Detail = $detail })
    $tag = if ($ok) { "PASS" } else { "FAIL" }
    $color = if ($ok) { "Green" } else { "Red" }
    Write-Host ("  [{0}] {1} — {2}" -f $tag, $name, $detail) -ForegroundColor $color
}

# codex 真身是 npm shim 拉起的原生二进制（codex-x86_64-pc-windows-msvc），
# 名字不固定，一律按前缀匹配，避免只数到 shim 漏掉真进程树。
function Get-CodexProcs { @(Get-Process -Name "codex*" -ErrorAction SilentlyContinue) }

function Start-Server($dataDir, $port, [hashtable]$extraEnv) {
    $envMap = @{ MICA_DATA_DIR = $dataDir; MICA_PORT = "$port"; RUST_LOG = "warn" }
    foreach ($k in $extraEnv.Keys) { $envMap[$k] = $extraEnv[$k] }
    $p = Start-Process -FilePath (Join-Path $repo "target\release\mica-server.exe") `
        -PassThru -WindowStyle Hidden -Environment $envMap
    foreach ($i in 1..40) {
        try { if ((Invoke-WebRequest "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq "ok") { return $p } }
        catch { Start-Sleep -Milliseconds 300 }
    }
    throw "server on $port failed to become healthy"
}

function Stop-All($proc) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Get-CodexProcs | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Submit($base, $body) {
    try {
        $r = Invoke-WebRequest -Method Post -Uri "$base/v1/tasks" -ContentType "application/json" `
            -Body ($body | ConvertTo-Json -Compress) -UseBasicParsing
        return [pscustomobject]@{ Code = $r.StatusCode; Json = ($r.Content | ConvertFrom-Json); Retry = $r.Headers["Retry-After"] }
    }
    catch {
        $resp = $_.Exception.Response
        $code = if ($resp) { [int]$resp.StatusCode } else { -1 }
        $retry = if ($resp) { $resp.Headers.GetValues("Retry-After") -join "" } else { $null }
        return [pscustomobject]@{ Code = $code; Json = $null; Retry = $retry }
    }
}

function Get-Metrics($base) {
    $m = @{}
    foreach ($line in (Invoke-RestMethod "$base/metrics") -split "`n") {
        if ($line -match '^(\S+?)(\{.*\})?\s+(\d+)$') { $m[$Matches[1] + $Matches[2]] = [int]$Matches[3] }
    }
    return $m
}

# 边等任务边采样：并发上限/RSS 只有在压测过程中才测得到，事后查无对证。
function Wait-Wave($base, $ids, $timeoutSec, [ref]$peak) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $maxProcs = 0; $maxInflight = 0; $maxRss = 0
    $states = @{}
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
        $n = (Get-CodexProcs).Count
        if ($n -gt $maxProcs) { $maxProcs = $n }
        $m = Get-Metrics $base
        if ($m["mica_inflight_total"] -gt $maxInflight) { $maxInflight = $m["mica_inflight_total"] }
        $srv = Get-Process -Id $script:serverPid -ErrorAction SilentlyContinue
        if ($srv -and $srv.WorkingSet64 -gt $maxRss) { $maxRss = $srv.WorkingSet64 }

        $pending = 0
        foreach ($id in $ids) {
            if ($states[$id] -and $states[$id] -in @("done", "error", "canceled")) { continue }
            $states[$id] = (Invoke-RestMethod "$base/v1/tasks/$id").state
            if ($states[$id] -notin @("done", "error", "canceled")) { $pending++ }
        }
        if ($pending -eq 0) { break }
        Start-Sleep -Milliseconds 700
    }
    $peak.Value = [pscustomobject]@{ Procs = $maxProcs; Inflight = $maxInflight; RssMB = [math]::Round($maxRss / 1MB, 1); Secs = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
    return $states
}

Write-Host "== 构建 release ==" -ForegroundColor Cyan
cargo build --release -p mica --features server 2>&1 | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { throw "build failed" }
Get-CodexProcs | Stop-Process -Force -ErrorAction SilentlyContinue

# ───────────────────────── S1：并发洪峰 + 租户公平 + 槽位隔离 ─────────────────────────
if ($Phase -in @("all", "s1")) {
    $script:curPhase = "S1 洪峰"
    Write-Host "`n== S1：$Tasks 个真 codex 任务洪峰（cli_slots=$Slots，9 租户 × 4）==" -ForegroundColor Cyan
    $dataDir = Join-Path $env:TEMP "mica-stress-s1-$PID"
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
    $port = 14501; $base = "http://127.0.0.1:$port"
    $proc = Start-Server $dataDir $port @{ MICA_CLI_SLOTS = "$Slots" }
    $script:serverPid = $proc.Id
    try {
        $ids = @(); $tokenOf = @{}; $tenantOf = @{}
        foreach ($i in 1..$Tasks) {
            $tenant = "t{0}" -f ([math]::Floor(($i - 1) / 4) + 1)
            $token = "MICA-{0:D3}-{1}" -f $i, (Get-Random -Maximum 99999)
            $r = Submit $base @{
                engine = "codex"; kind = "tool"; tenant = $tenant
                prompt = "把这一行文本原样写入当前目录的 out.txt：$token`n只做这一件事，不要创建其他文件，不要运行其他命令。"
            }
            if ($r.Code -ne 202) { Assert-Ok "提交 #$i" $false "HTTP $($r.Code)"; continue }
            $ids += $r.Json.task_id; $tokenOf[$r.Json.task_id] = $token; $tenantOf[$r.Json.task_id] = $tenant
        }
        Assert-Ok "洪峰提交" ($ids.Count -eq $Tasks) "$($ids.Count)/$Tasks 全部 202 入队"

        # 租户公平采样：任一时刻单租户在飞 ≤ tenant_cap(4)
        $fairViolation = $null
        $sampler = Start-ThreadJob -ScriptBlock {
            param($base, $ids, $tenantOf)
            $worst = 0
            for ($i = 0; $i -lt 600; $i++) {
                $running = @{}
                foreach ($id in $ids) {
                    try { $s = (Invoke-RestMethod "$base/v1/tasks/$id" -TimeoutSec 3).state } catch { continue }
                    if ($s -eq "running") { $running[$tenantOf[$id]] = 1 + ($running[$tenantOf[$id]] ?? 0) }
                }
                foreach ($v in $running.Values) { if ($v -gt $worst) { $worst = $v } }
                if ($running.Count -eq 0 -and $i -gt 10) { break }
                Start-Sleep -Milliseconds 900
            }
            $worst
        } -ArgumentList $base, $ids, $tenantOf

        $peak = $null
        $states = Wait-Wave $base $ids ($Tasks * 25) ([ref]$peak)
        $worstTenant = Receive-Job -Job (Wait-Job $sampler -Timeout 30) -ErrorAction SilentlyContinue
        Remove-Job $sampler -Force -ErrorAction SilentlyContinue

        $done = @($states.Values | Where-Object { $_ -eq "done" }).Count
        Assert-Ok "全部完成" ($done -eq $ids.Count) "$done/$($ids.Count) done（其余：$(($states.Values | Where-Object {$_ -ne 'done'}) -join ','))"
        Assert-Ok "并发闸不越界" ($peak.Inflight -le $Slots) "inflight 峰值 $($peak.Inflight) ≤ cli_slots=$Slots；真 codex 进程峰值 $($peak.Procs)"
        Assert-Ok "租户公平上限" ($worstTenant -le 4 -and $worstTenant -gt 0) "单租户在飞峰值 $worstTenant ≤ tenant_cap=4"

        # 产物正确性 + 串扰：每个工作区只能有自己的 token
        $bad = @(); $missing = @()
        foreach ($id in $ids) {
            $f = Join-Path $dataDir "workspaces\$($tenantOf[$id])\$id\out.txt"
            if (-not (Test-Path $f)) { $missing += $id; continue }
            $c = (Get-Content $f -Raw)
            if ($c -notmatch [regex]::Escape($tokenOf[$id])) { $bad += "$id 内容不符" }
            foreach ($other in $ids) {
                if ($other -ne $id -and $c -match [regex]::Escape($tokenOf[$other])) { $bad += "$id 串入 $other 的 token" }
            }
        }
        Assert-Ok "产物落盘" ($missing.Count -eq 0) "$($ids.Count - $missing.Count)/$($ids.Count) 工作区有 out.txt"
        Assert-Ok "零串扰" ($bad.Count -eq 0) "$($ids.Count) 个 token 互不污染 $(if($bad){'；异常：' + ($bad -join '；')})"

        $slotDirs = @(Get-ChildItem (Join-Path $dataDir "codex-home") -Directory -ErrorAction SilentlyContinue)
        Assert-Ok "槽位轮转" ($slotDirs.Count -le 64) "CODEX_HOME 槽位目录 $($slotDirs.Count) 个（并发上限 $Slots，轮转模 64）"
        Write-Host ("  峰值：inflight=$($peak.Inflight) codex进程=$($peak.Procs) 服务RSS=$($peak.RssMB)MB 耗时=$($peak.Secs)s") -ForegroundColor DarkGray
        $script:s1Rss = $peak.RssMB
        $script:s1SlotDirs = $slotDirs.Count
    }
    finally { Stop-All $proc; Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue }
}

# ───────────────────────── S2：混沌取消（杀树 + 槽位回收）─────────────────────────
if ($Phase -in @("all", "s2")) {
    $script:curPhase = "S2 混沌取消"
    Write-Host "`n== S2：16 个长跑 codex 任务，运行中批量取消 → 杀树 + 槽位不泄漏 ==" -ForegroundColor Cyan
    $dataDir = Join-Path $env:TEMP "mica-stress-s2-$PID"
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
    $port = 14502; $base = "http://127.0.0.1:$port"
    $proc = Start-Server $dataDir $port @{ MICA_CLI_SLOTS = "6" }
    $script:serverPid = $proc.Id
    try {
        $ids = @()
        foreach ($i in 1..16) {
            $r = Submit $base @{ engine = "codex"; kind = "tool"; tenant = "chaos$($i % 4)"
                prompt = "运行 PowerShell 命令 Start-Sleep 240 并等待它结束，然后回复完成。"
            }
            if ($r.Code -eq 202) { $ids += $r.Json.task_id }
        }
        Assert-Ok "长跑任务提交" ($ids.Count -eq 16) "$($ids.Count)/16 入队"

        # 等真进程树起来再砍，否则砍的是空壳测不出杀树
        foreach ($i in 1..60) {
            $m = Get-Metrics $base
            if ($m["mica_inflight_total"] -ge 6) { break }
            Start-Sleep -Seconds 1
        }
        Start-Sleep -Seconds 10
        $procsBefore = (Get-CodexProcs).Count
        $mBefore = Get-Metrics $base
        Assert-Ok "洪峰打满" ($mBefore["mica_inflight_total"] -ge 6) "inflight=$($mBefore['mica_inflight_total'])，codex 进程 $procsBefore 个在跑"

        # 全量取消：running 的走杀树，queued 的走出队
        $sw = [Diagnostics.Stopwatch]::StartNew()
        foreach ($id in $ids) {
            try { Invoke-WebRequest -Method Post -Uri "$base/v1/tasks/$id/cancel" -UseBasicParsing -TimeoutSec 5 | Out-Null } catch {}
        }
        $canceled = 0
        foreach ($i in 1..40) {
            $canceled = 0
            foreach ($id in $ids) { if ((Invoke-RestMethod "$base/v1/tasks/$id").state -eq "canceled") { $canceled++ } }
            if ($canceled -eq $ids.Count) { break }
            Start-Sleep -Milliseconds 500
        }
        Assert-Ok "批量取消收敛" ($canceled -eq $ids.Count) "$canceled/$($ids.Count) → canceled，耗时 $([math]::Round($sw.Elapsed.TotalSeconds,1))s"

        Start-Sleep -Seconds 3
        $leftover = Get-CodexProcs
        Assert-Ok "进程树零残留" ($leftover.Count -eq 0) "取消前 $procsBefore 个 codex 进程 → 现存 $($leftover.Count) 个"

        $mAfter = Get-Metrics $base
        Assert-Ok "槽位全回收" ($mAfter["mica_cli_slots_free"] -eq 6 -and $mAfter["mica_inflight_total"] -eq 0) `
            "cli_slots_free=$($mAfter['mica_cli_slots_free'])/6，inflight=$($mAfter['mica_inflight_total'])"

        # 取消风暴后调度器还能不能干活（信号量泄漏的照妖镜）
        $r = Submit $base @{ engine = "codex"; kind = "tool"; tenant = "after"; prompt = "把 ALIVE 写入当前目录 alive.txt，只做这一件事。" }
        $peak2 = $null
        $st = Wait-Wave $base @($r.Json.task_id) 180 ([ref]$peak2)
        Assert-Ok "取消风暴后可用" ($st[$r.Json.task_id] -eq "done") "后续任务 state=$($st[$r.Json.task_id])（$($peak2.Secs)s）"
    }
    finally { Stop-All $proc; Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue }
}

# ───────────────────── S3：背压 + 优先级（mock 引擎，不烧 codex 配额）─────────────────────
if ($Phase -in @("all", "s3")) {
    $script:curPhase = "S3 背压"
    Write-Host "`n== S3：queue_cap=16 灌 300 单 → 429 背压；高优先级插队（mock CLI）==" -ForegroundColor Cyan
    $dataDir = Join-Path $env:TEMP "mica-stress-s3-$PID"
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
    $port = 14503; $base = "http://127.0.0.1:$port"
    $proc = Start-Server $dataDir $port @{
        MICA_CLI_SLOTS = "2"; MICA_QUEUE_CAP = "16"
        MICA_CLAUDE_EXE = (Join-Path $repo "target\release\mock-claude.exe")
    }
    $script:serverPid = $proc.Id
    try {
        $ok = 0; $rejected = 0; $retryAfter = $null; $otherCode = @()
        foreach ($i in 1..300) {
            $r = Submit $base @{ engine = "claude"; kind = "tool"; tenant = "flood$($i % 7)"; prompt = "hi $i" }
            switch ($r.Code) {
                202 { $ok++ }
                429 { $rejected++; if (-not $retryAfter) { $retryAfter = $r.Retry } }
                default { $otherCode += $r.Code }
            }
        }
        Assert-Ok "背压生效" ($rejected -gt 0) "300 单：202×$ok / 429×$rejected（队列 cap=16，2 槽位）"
        Assert-Ok "429 带 Retry-After" ([bool]$retryAfter) "Retry-After: $retryAfter"
        Assert-Ok "无异常状态码" ($otherCode.Count -eq 0) "非 202/429 响应 $($otherCode.Count) 个 $(if($otherCode){'：' + (($otherCode | Select-Object -Unique) -join ',')})"

        $m = Get-Metrics $base
        Assert-Ok "队列不越界" (($m["mica_queue_depth{priority=`"high`"}"] + $m["mica_queue_depth{priority=`"normal`"}"] + $m["mica_queue_depth{priority=`"low`"}"]) -le 16) `
            "队列深度 high/normal/low = $($m['mica_queue_depth{priority="high"}'])/$($m['mica_queue_depth{priority="normal"}'])/$($m['mica_queue_depth{priority="low"}'])"

        # 缺口探针：队列打满时 high 能否挤进来（admission control 是否认优先级）
        $rhFull = Submit $base @{ engine = "claude"; kind = "tool"; tenant = "vip"; prompt = "vip"; priority = "high" }
        Assert-Ok "满队时 high 可入" ($rhFull.Code -eq 202) `
            "队列满(16/16)时提交 high → HTTP $($rhFull.Code)$(if($rhFull.Code -eq 429){'（admission 只看深度不看优先级：一队 low 就能把 high 挡在门外）'})"
    }
    finally { Stop-All $proc; Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue }

    # 队列未满时的优先级排序（与上面的 admission 缺口分开验，避免两件事混成一个断言）
    $dataDir2 = Join-Path $env:TEMP "mica-stress-s3b-$PID"
    Remove-Item -Recurse -Force $dataDir2 -ErrorAction SilentlyContinue
    $port2 = 14513; $base2 = "http://127.0.0.1:$port2"
    $proc2 = Start-Server $dataDir2 $port2 @{
        MICA_CLI_SLOTS = "1"; MICA_QUEUE_CAP = "200"
        MICA_CLAUDE_EXE = (Join-Path $repo "target\release\mock-claude.exe")
    }
    $script:serverPid = $proc2.Id
    try {
        foreach ($i in 1..20) { Submit $base2 @{ engine = "claude"; kind = "tool"; tenant = "bulk$($i % 5)"; prompt = "n$i" } | Out-Null }
        foreach ($i in 1..5) { Submit $base2 @{ engine = "claude"; kind = "tool"; tenant = "bulk$i"; prompt = "l$i"; priority = "low" } | Out-Null }
        $rh = Submit $base2 @{ engine = "claude"; kind = "tool"; tenant = "vip"; prompt = "vip"; priority = "high" }
        Assert-Ok "高优先级插队" ($rh.Code -eq 202 -and $rh.Json.position -eq 0) `
            "20 normal + 5 low 堆积中投 high → 位次 $($rh.Json.position)（期望 0，队首）"
        $rl = Submit $base2 @{ engine = "claude"; kind = "tool"; tenant = "vip"; prompt = "tail"; priority = "low" }
        Assert-Ok "低优先级垫底" ($rl.Code -eq 202 -and $rl.Json.position -ge 25) `
            "low 任务位次 $($rl.Json.position)（期望 ≥25，排在所有 normal 之后）"
    }
    finally { Stop-All $proc2; Remove-Item -Recurse -Force $dataDir2 -ErrorAction SilentlyContinue }
}

# ───────────────────── S4：负载下 SSE 事件完整性 + Last-Event-ID 续传 ─────────────────────
if ($Phase -in @("all", "s4")) {
    $script:curPhase = "S4 SSE"
    Write-Host "`n== S4：负载下 SSE 断连续传（Last-Event-ID 不丢事件）==" -ForegroundColor Cyan
    $dataDir = Join-Path $env:TEMP "mica-stress-s4-$PID"
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
    $port = 14504; $base = "http://127.0.0.1:$port"
    $proc = Start-Server $dataDir $port @{ MICA_CLI_SLOTS = "4" }
    $script:serverPid = $proc.Id
    try {
        $r = Submit $base @{ engine = "codex"; kind = "tool"; tenant = "sse"
            prompt = "依次把 1 到 5 这五个数字，每个数字单独写一行，写入当前目录的 nums.txt。只做这一件事。"
        }
        $id = $r.Json.task_id
        # 先断一次（只收 6s），记住最后事件 id，再用 Last-Event-ID 续
        $first = (& curl.exe -s -N -m 6 "$base/v1/tasks/$id/events") -join "`n"
        $firstIds = [regex]::Matches($first, '(?m)^id:\s*(\d+)') | ForEach-Object { [int]$_.Groups[1].Value }
        Assert-Ok "SSE 首连有事件" ($firstIds.Count -gt 0) "收到 $($firstIds.Count) 个事件，末位 id=$($firstIds[-1])"

        $peak3 = $null
        $st = Wait-Wave $base @($id) 240 ([ref]$peak3)
        $lastId = if ($firstIds.Count) { $firstIds[-1] } else { 0 }
        $resume = (& curl.exe -s -N -m 8 -H "Last-Event-ID: $lastId" "$base/v1/tasks/$id/events") -join "`n"
        $resumeIds = [regex]::Matches($resume, '(?m)^id:\s*(\d+)') | ForEach-Object { [int]$_.Groups[1].Value }
        $full = (& curl.exe -s -N -m 8 "$base/v1/tasks/$id/events") -join "`n"
        $fullIds = [regex]::Matches($full, '(?m)^id:\s*(\d+)') | ForEach-Object { [int]$_.Groups[1].Value }

        Assert-Ok "任务完成" ($st[$id] -eq "done") "state=$($st[$id])"
        Assert-Ok "续传不重发" (($resumeIds | Where-Object { $_ -le $lastId }).Count -eq 0) `
            "Last-Event-ID=$lastId 续传返回 $($resumeIds.Count) 个事件，最小 id=$(if($resumeIds){($resumeIds | Measure-Object -Minimum).Minimum}else{'-'})"
        $gapOk = $true
        for ($i = 1; $i -lt $fullIds.Count; $i++) { if ($fullIds[$i] -ne $fullIds[$i - 1] + 1) { $gapOk = $false } }
        Assert-Ok "事件 id 连续无洞" $gapOk "全量重放 $($fullIds.Count) 个事件，id 单调 +1"
        $union = @($firstIds) + @($resumeIds) | Select-Object -Unique
        Assert-Ok "断连不丢事件" ($union.Count -ge $fullIds.Count) "首连 $($firstIds.Count) + 续传 $($resumeIds.Count) 覆盖全量 $($fullIds.Count)"
    }
    finally { Stop-All $proc; Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue }
}

# ───────────────────────── S5：长稳（多轮波次，内存漂移）─────────────────────────
if ($Phase -in @("all", "s5")) {
    $script:curPhase = "S5 长稳"
    Write-Host "`n== S5：4 波 × 6 个真 codex 任务连打 → RSS 漂移 / 句柄泄漏 ==" -ForegroundColor Cyan
    $dataDir = Join-Path $env:TEMP "mica-stress-s5-$PID"
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
    $port = 14505; $base = "http://127.0.0.1:$port"
    $proc = Start-Server $dataDir $port @{ MICA_CLI_SLOTS = "3" }
    $script:serverPid = $proc.Id
    try {
        $rssTrail = @(); $handleTrail = @(); $allDone = $true
        foreach ($wave in 1..4) {
            $ids = @()
            foreach ($i in 1..6) {
                $r = Submit $base @{ engine = "codex"; kind = "tool"; tenant = "soak$($i % 3)"
                    prompt = "把 W$wave-$i 写入当前目录的 w.txt，只做这一件事。"
                }
                if ($r.Code -eq 202) { $ids += $r.Json.task_id }
            }
            $pk = $null
            $st = Wait-Wave $base $ids 300 ([ref]$pk)
            $doneN = @($st.Values | Where-Object { $_ -eq "done" }).Count
            if ($doneN -ne $ids.Count) { $allDone = $false }
            [GC]::Collect(); Start-Sleep -Seconds 2
            $srv = Get-Process -Id $script:serverPid
            $rssTrail += [math]::Round($srv.WorkingSet64 / 1MB, 1)
            $handleTrail += $srv.HandleCount
            Write-Host ("  波次 $wave：done $doneN/$($ids.Count)，RSS $($rssTrail[-1])MB，句柄 $($handleTrail[-1])，$($pk.Secs)s") -ForegroundColor DarkGray
        }
        Assert-Ok "长稳全完成" $allDone "4 波 × 6 任务全部 done"
        $drift = $rssTrail[-1] - $rssTrail[0]
        Assert-Ok "内存无泄漏" ($drift -lt 50) "RSS 轨迹 $($rssTrail -join ' → ')MB，漂移 $drift MB（阈值 50MB）"
        $hDrift = $handleTrail[-1] - $handleTrail[0]
        Assert-Ok "句柄无泄漏" ($hDrift -lt 200) "句柄轨迹 $($handleTrail -join ' → ')，漂移 $hDrift（阈值 200）"
    }
    finally { Stop-All $proc; Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue }
}

# ───────────────────────── 汇总 ─────────────────────────
Write-Host "`n════════ 强度测试汇总 ════════" -ForegroundColor Cyan
$script:results | Format-Table -AutoSize Phase, Case, Ok, Detail | Out-String -Width 200 | Write-Host
$fail = @($script:results | Where-Object { -not $_.Ok })
$outJson = Join-Path $env:TEMP "mica-stress-report-$PID.json"
$script:results | ConvertTo-Json -Depth 4 | Set-Content $outJson -Encoding utf8
Write-Host "明细：$outJson"
if ($fail.Count -eq 0) {
    Write-Host "STRESS PASS：$($script:results.Count) 项断言全过" -ForegroundColor Green
}
else {
    Write-Host "STRESS FAIL：$($fail.Count)/$($script:results.Count) 项未过 → $(($fail | ForEach-Object { $_.Case }) -join '；')" -ForegroundColor Red
    exit 1
}
