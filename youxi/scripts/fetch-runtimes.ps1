# 按 runtimes.lock.json 拉取 CLI 原生二进制（PRD 6.4 / 8.1）：多源轮询 + sha256 校验。
# 产物落 resources/runtimes/<name>/<version>/（.gitignore，不进 git 历史）。
param(
    [string]$Target = "x86_64-pc-windows-msvc"
)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$lock = Get-Content (Join-Path $repo "runtimes.lock.json") -Raw | ConvertFrom-Json

foreach ($name in $lock.runtimes.PSObject.Properties.Name) {
    $rt = $lock.runtimes.$name
    $version = $rt.version
    if ($version -like "*pin-me*") {
        Write-Host "[$name] 版本未钉死（$version），跳过——发版前必须在 runtimes.lock.json 钉死版本与 sha256" -ForegroundColor Yellow
        continue
    }
    $destDir = Join-Path $repo "resources\runtimes\$name\$version"
    $exeName = if ($Target -like "*windows*") { "$name.exe" } else { $name }
    $dest = Join-Path $destDir $exeName
    $expected = $rt.sha256.$Target
    if ((Test-Path $dest) -and $expected -and ((Get-FileHash $dest -Algorithm SHA256).Hash -eq $expected)) {
        Write-Host "[$name] $version 已就位且校验通过" -ForegroundColor Green
        continue
    }
    New-Item -ItemType Directory -Force $destDir | Out-Null
    $fetched = $false
    foreach ($source in $rt.sources) {
        $url = $source -replace '\{version\}', $version -replace '\{target\}', $Target
        Write-Host "[$name] 拉取 $url"
        try {
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
            if ($expected -and $expected -ne "PIN_ME") {
                $actual = (Get-FileHash $dest -Algorithm SHA256).Hash
                if ($actual -ne $expected) {
                    Write-Host "[$name] sha256 不匹配（期望 $expected，实际 $actual），换源重试" -ForegroundColor Red
                    Remove-Item $dest -Force; continue
                }
            }
            $fetched = $true; break
        } catch {
            Write-Host "[$name] 源失败：$($_.Exception.Message)，换下一源" -ForegroundColor Yellow
        }
    }
    if (-not $fetched) { Write-Host "[$name] 全部源失败" -ForegroundColor Red; exit 1 }
    Write-Host "[$name] $version 就绪 → $dest" -ForegroundColor Green
}
