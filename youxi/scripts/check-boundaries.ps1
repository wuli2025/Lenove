# 模块边界闸（PRD 8.2）：扫描 crates/mica/src/<module>/ 内的 crate::<module> 引用，
# 强制单向依赖 server → engine → provider → runtime → core（doctor → runtime → core）。
# 违规即退出码 1（CI 红灯拦 PR）。
$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot "..\crates\mica\src"

# 各模块允许引用的下游模块（自身总是允许）
$allowed = @{
    "core"     = @()
    "runtime"  = @("core")
    "provider" = @("core", "runtime")
    "engine"   = @("core", "runtime", "provider")
    "doctor"   = @("core", "runtime")
    "publish"  = @("core", "runtime")
    "server"   = @("core", "runtime", "provider", "engine")
}

$violations = @()
foreach ($module in $allowed.Keys) {
    $dir = Join-Path $root $module
    if (-not (Test-Path $dir)) { continue }
    $files = Get-ChildItem $dir -Filter *.rs -Recurse
    foreach ($file in $files) {
        $lineNo = 0
        foreach ($line in Get-Content $file.FullName) {
            $lineNo++
            if ($line -match '^\s*//') { continue }  # 注释行不算
            foreach ($m in [regex]::Matches($line, 'crate::(\w+)')) {
                $target = $m.Groups[1].Value
                if ($target -eq $module) { continue }
                if (-not $allowed.ContainsKey($target)) { continue }  # 非板块模块（如宏路径）
                if ($allowed[$module] -notcontains $target) {
                    $violations += "$($file.Name):$lineNo  [$module → $target]  $($line.Trim())"
                }
            }
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host "边界违规 $($violations.Count) 处（依赖方向必须 server→engine→provider→runtime→core）:" -ForegroundColor Red
    $violations | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}
Write-Host "check-boundaries: OK（模块依赖方向零违规）" -ForegroundColor Green
