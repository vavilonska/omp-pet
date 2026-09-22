param(
  [string]$Profile = ""
)

$ErrorActionPreference = "Stop"
$packageId = "omp-pet-adapter"
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
if (-not (Test-Path -LiteralPath $target)) {
  Write-Host "OMP Pet Adapter is not installed for this profile."
  exit 0
}

$markerPath = Join-Path $target ".omp-pet-package.json"
if (-not (Test-Path -LiteralPath $markerPath)) {
  throw "Refusing to remove an unrecognized extension directory: $target"
}
$marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if ($marker.packageId -ne $packageId) {
  throw "Refusing to remove extension package '$($marker.packageId)'."
}

Remove-Item -LiteralPath $target -Recurse -Force
Write-Host "OMP Pet Adapter removed from: $target"

