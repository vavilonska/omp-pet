# OMP Pet Adapter — Windows x64

This is a self-contained Oh My Pi extension package. It includes the `/pet` extension, its Windows x64 desktop runtime, and the required WebView2 loader. It contains no character artwork and imports nothing during installation. The installer verifies all payload SHA-256 hashes before copying.

The installed extension includes `docs/ANIMATION_TIMING.md`, which records the versioned Codex desktop per-frame timing reference and OMP playback policy for reuse.

## Install for the default OMP profile

Double-click `install.cmd`, or run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Restart OMP after installation. `/pet` will be registered automatically; the desktop runtime starts only when `/pet` is first used.

For a named OMP profile:

```powershell
.\install.ps1 -Profile work
```

## Uninstall

Double-click `uninstall.cmd`, or run `uninstall.ps1` with the same optional `-Profile` value. Uninstalling the adapter does not delete imported OMP pet data.
