param([Parameter(Mandatory = $true)][int]$RuntimePid)

$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PetWindowRegions {
  public delegate bool EnumWindow(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder title, int size);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr region, int x, int y);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  public static IntPtr Find(int processId) {
    IntPtr result = IntPtr.Zero;
    EnumWindows((hwnd, data) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      var title = new StringBuilder(128);
      GetWindowText(hwnd, title, title.Capacity);
      if (pid == processId && title.ToString() == "OMP Pet") { result = hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@

$petWindow = [PetWindowRegions]::Find($RuntimePid)
if ($petWindow -eq [IntPtr]::Zero) { throw "OMP test window not found for PID $RuntimePid" }
$petRegion = [PetWindowRegions]::CreateRectRgn(0, 0, 0, 0)
try {
  $petRegionType = [PetWindowRegions]::GetWindowRgn($petWindow, $petRegion)
  if ($petRegionType -eq 0) { throw "The WebView did not install a native window region" }
  $petScale = [PetWindowRegions]::GetDpiForWindow($petWindow) / 96.0
  $nativeCaptionRemoved = ([PetWindowRegions]::GetWindowLong($petWindow, -16) -band 0xC00000) -eq 0
  if (-not $nativeCaptionRemoved) { throw "Native title/icon frame is still present under the transparent pet window" }
  $petTopBlocked = [PetWindowRegions]::PtInRegion($petRegion, [int](116 * $petScale), [int](20 * $petScale))
  $petClient = New-Object PetWindowRegions+Rect
  if (-not [PetWindowRegions]::GetClientRect($petWindow, [ref]$petClient)) { throw "Could not read pet window size" }
  $petBodyInteractive = [PetWindowRegions]::PtInRegion($petRegion, [int](116 * $petScale), [int]($petClient.Bottom - 64 * $petScale))
  if ($petTopBlocked -or -not $petBodyInteractive) { throw "Native region did not exclude the blank top and preserve the pet/placeholder" }
  @{ nativeRegion = $true; nativeCaptionRemoved = $nativeCaptionRemoved; blankTopPassesThrough = -not $petTopBlocked; petAreaInteractive = $petBodyInteractive; scale = $petScale } | ConvertTo-Json -Compress
}
finally {
  [PetWindowRegions]::DeleteObject($petRegion) | Out-Null
}
