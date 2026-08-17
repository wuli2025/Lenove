# 抓指定进程主窗口的截图。
# 桌面端是 GUI，光看进程活着不算验证——必须看见窗口里到底渲染成什么样。
# 用法： pwsh -NoProfile -File shot-window.ps1 -Exe "一句话生成" -Out shot.png -WaitSec 8
param(
  [string]$Exe = "一句话生成",
  [string]$Out = "$env:TEMP\app-shot.png",
  [int]$WaitSec = 8
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$deadline = (Get-Date).AddSeconds($WaitSec)
$proc = $null
while ((Get-Date) -lt $deadline) {
  $proc = Get-Process | Where-Object { $_.ProcessName -like "*$Exe*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) { break }
  Start-Sleep -Milliseconds 400
}
if (-not $proc) { Write-Error "等了 $WaitSec 秒没等到 $Exe 的主窗口"; exit 1 }

# 拉到前台再截，否则被别的窗口盖住只能拍到一片别人的界面
[void][Win]::ShowWindow($proc.MainWindowHandle, 9)   # SW_RESTORE
[void][Win]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 1200

$r = New-Object Win+RECT
if (-not [Win]::GetWindowRect($proc.MainWindowHandle, [ref]$r)) { Write-Error "拿不到窗口矩形"; exit 1 }
$w = $r.R - $r.L; $h = $r.B - $r.T
if ($w -le 0 -or $h -le 0) { Write-Error "窗口尺寸异常 ${w}x${h}"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

Write-Host "pid=$($proc.Id)  ${w}x${h}  → $Out"
