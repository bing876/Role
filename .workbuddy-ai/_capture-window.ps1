# 截取已安装版 AI 工作台窗口。
# ★ 本机两个坑：
#   1) .ps1 里不要写中文（UTF-8 无 BOM 会被 PowerShell 5.1 读成乱码，导致 -match 永远不中）。
#      这里全程用 ASCII：靠 ExecutablePath 含 'ai-workbenchdesktop' 反查 pid。
#   2) 截之前必须先 ShowWindow(SW_RESTORE) + SetForegroundWindow，否则被遮挡会截到别的窗口。
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(CB cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public delegate bool CB(IntPtr h, IntPtr l);
}
"@

$log = "C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\_capture.log"
function L($m) { Add-Content -Path $log -Value $m -Encoding UTF8 }
Remove-Item $log -ErrorAction SilentlyContinue

# 1) 目标进程 pid（路径里含 ai-workbenchdesktop，全 ASCII）
$pids = @()
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.ExecutablePath -and $_.ExecutablePath -like "*ai-workbenchdesktop*") { $pids += $_.ProcessId }
}
$pids = $pids | Sort-Object -Unique
L ("targetPids=" + ($pids -join ','))

# 2) 找属于这些 pid 的可见窗口
$hit = $null
$cb = [Win+CB]{
  param($h,$l)
  if ([Win]::IsWindowVisible($h)) {
    $p = 0
    [Win]::GetWindowThreadProcessId($h,[ref]$p) | Out-Null
    if ($script:pids -contains $p) {
      $r = New-Object Win+RECT
      [Win]::GetWindowRect($h,[ref]$r) | Out-Null
      $w = $r.R - $r.L; $ht = $r.B - $r.T
      if ($w -gt 500 -and $ht -gt 400) {
        $sb = New-Object System.Text.StringBuilder 512
        [Win]::GetWindowText($h,$sb,512) | Out-Null
        $script:hit = [PSCustomObject]@{ H=$h; Pid=$p; Title=$sb.ToString(); L=$r.L; T=$r.T; W=$w; Ht=$ht }
      }
    }
  }
  return $true
}
[Win]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null

if (-not $hit) { L "NO_WINDOW"; exit 1 }
L ("HIT pid=" + $hit.Pid + " size=" + $hit.W + "x" + $hit.Ht + " at " + $hit.L + "," + $hit.T)

[Win]::ShowWindow($hit.H, 9) | Out-Null
Start-Sleep -Milliseconds 500
[Win]::SetForegroundWindow($hit.H) | Out-Null
Start-Sleep -Milliseconds 1200

Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $hit.W, $hit.Ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($hit.L, $hit.T, 0, 0, $bmp.Size)
$out = "C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\acceptance-window.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
L ("SAVED " + $out)
