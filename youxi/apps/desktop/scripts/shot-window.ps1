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
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int awareness);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static IntPtr LargestVisibleWindow(uint wantedPid) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      RECT r;
      if (pid == wantedPid && IsWindowVisible(h) && GetWindowRect(h, out r)) {
        long width = Math.Max(0, r.R - r.L);
        long height = Math.Max(0, r.B - r.T);
        long area = width * height;
        if (area > bestArea) { bestArea = area; best = h; }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@

# 高 DPI 屏必须先切到 per-monitor aware；否则 GetWindowRect 是逻辑像素，
# CopyFromScreen 却按物理像素抓，最终只会截到窗口左上角并被放大。
try { [void][Win]::SetProcessDpiAwareness(2) } catch { }

$deadline = (Get-Date).AddSeconds($WaitSec)
$proc = $null
$handle = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $candidates = Get-Process | Where-Object { $_.ProcessName -like "*$Exe*" }
  foreach ($candidate in $candidates) {
    $candidateHandle = [Win]::LargestVisibleWindow([uint32]$candidate.Id)
    if ($candidateHandle -eq [IntPtr]::Zero) { continue }
    $candidateRect = New-Object Win+RECT
    if ([Win]::GetWindowRect($candidateHandle, [ref]$candidateRect)) {
      $candidateWidth = $candidateRect.R - $candidateRect.L
      $candidateHeight = $candidateRect.B - $candidateRect.T
      # Tauri 启动初期可能先出现 26×26 的辅助窗口；等真正主窗口可见后再继续。
      if ($candidateWidth -ge 300 -and $candidateHeight -ge 300) {
        $proc = $candidate
        $handle = $candidateHandle
        break
      }
    }
  }
  if ($proc) { break }
  Start-Sleep -Milliseconds 400
}
if (-not $proc) { Write-Error "等了 $WaitSec 秒没等到 $Exe 的可见主窗口"; exit 1 }

# Tauri/WebView2 同一进程里可能有一个 26×26 的隐藏辅助窗口；
# Process.MainWindowHandle 偶尔会指向它。枚举同进程窗口并选面积最大的可见窗口。
[void][Win]::ShowWindow($handle, 9)   # SW_RESTORE
[void][Win]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 1200

$r = New-Object Win+RECT
if (-not [Win]::GetWindowRect($handle, [ref]$r)) { Write-Error "拿不到窗口矩形"; exit 1 }
$w = $r.R - $r.L; $h = $r.B - $r.T
if ($w -le 0 -or $h -le 0) { Write-Error "窗口尺寸异常 ${w}x${h}"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
# CopyFromScreen 会在 SetForegroundWindow 被 Windows 拒绝时拍到盖在上面的浏览器；
# PrintWindow 直接让目标 HWND 画进位图，窗口被遮挡也不会串到别的应用。
$hdc = $g.GetHdc()
$printed = [Win]::PrintWindow($handle, $hdc, 2) # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
if (-not $printed) { $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size) }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

Write-Host "pid=$($proc.Id)  ${w}x${h}  → $Out"
