Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(CB cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public delegate bool CB(IntPtr h, IntPtr l);
}
"@

$lines = @()
$cb = [W2+CB]{
  param($h,$l)
  if ([W2]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [W2]::GetWindowText($h,$sb,512) | Out-Null
    $t = $sb.ToString()
    if ($t -and $t.Trim().Length -gt 0) {
      $r = New-Object W2+RECT
      [W2]::GetWindowRect($h,[ref]$r) | Out-Null
      $pid = 0
      [W2]::GetWindowThreadProcessId($h,[ref]$pid) | Out-Null
      $w = $r.R - $r.L; $ht = $r.B - $r.T
      if ($w -gt 300 -and $ht -gt 200) {
        $script:lines += ("{0}`t{1}`t{2}x{3}`t{4},{5}" -f $pid, $t, $w, $ht, $r.L, $r.T)
      }
    }
  }
  return $true
}
[W2]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null

$out = "C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\_windows.txt"
$lines | Set-Content -Path $out -Encoding UTF8
"count=" + $lines.Count | Add-Content -Path $out -Encoding UTF8
