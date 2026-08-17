# 抓指定进程主窗口的截图（DPI 感知版）。
#
# 为什么要单独一个：本机 dpr=2，PowerShell 进程默认不是 per-monitor DPI aware，
# GetWindowRect 拿回来的是被系统虚拟化过的逻辑坐标，CopyFromScreen 又按物理像素取图，
# 结果只截到窗口左上角四分之一，看上去像"界面崩了"，其实是量尺子的人瞎了。
# 必须在碰任何 GDI 之前先声明 DPI 感知。
#
# 用法： pwsh -NoProfile -File shot-window-dpi.ps1 -Exe "yiju-desktop" -Out shot.png -WaitSec 12
param(
  [string]$Exe = "yiju-desktop",
  [string]$Out = "$env:TEMP\app-shot.png",
  [int]$WaitSec = 12,
  [int]$Pid_ = 0
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinDpi {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

# 2 = PROCESS_PER_MONITOR_DPI_AWARE。已经设过会返回 E_ACCESSDENIED，退回旧 API 也行。
try { [void][WinDpi]::SetProcessDpiAwareness(2) } catch { try { [void][WinDpi]::SetProcessDPIAware() } catch {} }

$deadline = (Get-Date).AddSeconds($WaitSec)
$proc = $null
while ((Get-Date) -lt $deadline) {
  $cands = if ($Pid_ -gt 0) { Get-Process -Id $Pid_ -ErrorAction SilentlyContinue } else { Get-Process | Where-Object { $_.ProcessName -like "*$Exe*" } }
  $proc = $cands | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) { break }
  Start-Sleep -Milliseconds 400
}
if (-not $proc) { Write-Error "等了 $WaitSec 秒没等到 $Exe 的主窗口"; exit 1 }

[void][WinDpi]::ShowWindow($proc.MainWindowHandle, 9)   # SW_RESTORE
[void][WinDpi]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 1500

$r = New-Object WinDpi+RECT
if (-not [WinDpi]::GetWindowRect($proc.MainWindowHandle, [ref]$r)) { Write-Error "拿不到窗口矩形"; exit 1 }
$w = $r.R - $r.L; $h = $r.B - $r.T
if ($w -le 0 -or $h -le 0) { Write-Error "窗口尺寸异常 ${w}x${h}"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

Write-Host "pid=$($proc.Id)  rect=$($r.L),$($r.T) ${w}x${h}  → $Out"
