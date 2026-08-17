# 抓窗口截图（PrintWindow 版，能穿透遮挡）。
#
# 为什么不用 CopyFromScreen：Windows 不许后台进程抢前台，SetForegroundWindow 经常静默失败，
# 于是截到的是盖在上面的微信/编辑器，看上去像"应用白屏了"，其实只是没在最上层。
# PrintWindow + PW_RENDERFULLCONTENT(2) 直接让窗口把自己画到我们的 DC 上，
# 不依赖 Z 序，也不打断用户正在做的事。WebView2 必须带 flag 2，否则内容区是黑的。
#
# 依旧要先声明 DPI 感知：本机 dpr=2，不声明只截左上角四分之一。
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
public class PW {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
try { [void][PW]::SetProcessDpiAwareness(2) } catch { try { [void][PW]::SetProcessDPIAware() } catch {} }

$deadline = (Get-Date).AddSeconds($WaitSec)
$proc = $null
while ((Get-Date) -lt $deadline) {
  $cands = if ($Pid_ -gt 0) { Get-Process -Id $Pid_ -ErrorAction SilentlyContinue } else { Get-Process | Where-Object { $_.ProcessName -like "*$Exe*" } }
  $proc = $cands | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) { break }
  Start-Sleep -Milliseconds 400
}
if (-not $proc) { Write-Error "等了 $WaitSec 秒没等到 $Exe 的主窗口"; exit 1 }
$h = $proc.MainWindowHandle

# 最小化的窗口画不出内容，先还原（这一步不抢前台）
if ([PW]::IsIconic($h)) { [void][PW]::ShowWindow($h, 9); Start-Sleep -Milliseconds 1200 }

$r = New-Object PW+RECT
if (-not [PW]::GetWindowRect($h, [ref]$r)) { Write-Error "拿不到窗口矩形"; exit 1 }
$w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0) { Write-Error "窗口尺寸异常 ${w}x${ht}"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [PW]::PrintWindow($h, $hdc, 2)   # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "pid=$($proc.Id)  printwindow=$ok  ${w}x${ht}  → $Out"
