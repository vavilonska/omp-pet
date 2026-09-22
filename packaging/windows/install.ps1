param(
  [string]$Profile = ""
)

$ErrorActionPreference = "Stop"
$packageId = "omp-pet-adapter"
$scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$payloadRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "payload"))
$userProfile = [Environment]::GetFolderPath("UserProfile")

if ($Profile) {
  if ($Profile -notmatch '^[a-zA-Z0-9._-]+$') {
    throw "Profile may contain only letters, numbers, dots, underscores, and hyphens."
  }
  $agentRoot = Join-Path $userProfile ".omp\profiles\$Profile\agent"
}
elseif ($env:PI_CODING_AGENT_DIR) {
  $agentRoot = $env:PI_CODING_AGENT_DIR
}
else {
  $agentRoot = Join-Path $userProfile ".omp\agent"
}

$agentRoot = [IO.Path]::GetFullPath($agentRoot)
$extensionsRoot = [IO.Path]::GetFullPath((Join-Path $agentRoot "extensions"))
$target = [IO.Path]::GetFullPath((Join-Path $extensionsRoot "omp-pet"))
if (-not $target.StartsWith($extensionsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe extension target path."
}

$required = @(
  "package.json",
  ".omp-pet-package.json",
  "dist\index.js",
  "bin\win32-x64\runtime-current.txt",
  "SHA256SUMS.json"
)
foreach ($relativePath in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $payloadRoot $relativePath))) {
    throw "Package is incomplete: missing $relativePath"
  }
}

$runtimeRelative = (Get-Content -LiteralPath (Join-Path $payloadRoot "bin\win32-x64\runtime-current.txt") -Raw).Trim().Replace("/", "\")
if ($runtimeRelative -notmatch '^[a-f0-9]{12}\\omp-pet-runtime\.exe$') {
  throw "Package runtime pointer is invalid."
}
foreach ($relativePath in @("bin\win32-x64\$runtimeRelative", "bin\win32-x64\$($runtimeRelative.Replace('omp-pet-runtime.exe', 'WebView2Loader.dll'))")) {
  if (-not (Test-Path -LiteralPath (Join-Path $payloadRoot $relativePath))) {
    throw "Package is incomplete: missing $relativePath"
  }
}

$checksums = Get-Content -LiteralPath (Join-Path $payloadRoot "SHA256SUMS.json") -Raw | ConvertFrom-Json
foreach ($entry in $checksums.PSObject.Properties) {
  $candidate = [IO.Path]::GetFullPath((Join-Path $payloadRoot $entry.Name))
  if (-not $candidate.StartsWith($payloadRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe checksum path: $($entry.Name)"
  }
  $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne [string]$entry.Value) {
    throw "Checksum mismatch: $($entry.Name)"
  }
}

if (Test-Path -LiteralPath $target) {
  $installedMarkerPath = Join-Path $target ".omp-pet-package.json"
  if (-not (Test-Path -LiteralPath $installedMarkerPath)) {
    throw "Refusing to overwrite an unrecognized extension directory: $target"
  }
  $installedMarker = Get-Content -LiteralPath $installedMarkerPath -Raw | ConvertFrom-Json
  if ($installedMarker.packageId -ne $packageId) {
    throw "Refusing to overwrite extension package '$($installedMarker.packageId)'."
  }
}

New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -Path (Join-Path $payloadRoot "*") -Destination $target -Recurse -Force
Copy-Item -LiteralPath (Join-Path $payloadRoot ".omp-pet-package.json") -Destination $target -Force

Write-Host "OMP Pet Adapter installed to: $target"
Write-Host "Restart OMP, then run /pet. No character assets were installed."
