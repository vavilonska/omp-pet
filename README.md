# OMP Pet Adapter

OMP Pet Adapter is a standalone desktop-pet runtime plus an Oh My Pi extension. It lets OMP summon and control Codex-compatible sprite pets through `/pet` without coupling the pet process to OMP internals.

This repository currently contains the framework only. It does not import, copy, or bundle Angela or any other character artwork.

## Download and install

Download the Windows x64 ZIP from [Releases](https://github.com/vavilonska/omp-pet/releases), extract it, and run `install.cmd`. Restart OMP, then run `/pet`.

Requires Windows x64, Oh My Pi and Microsoft Edge WebView2 Runtime. The archive includes the runtime and extension; end users do not need Bun or Rust. No character artwork is bundled: import your own compatible v2 pet with `/pet import "C:\path\to\pet-package"`. Until then a placeholder is shown. See [package format](docs/PET_PACKAGE.md).

This is an independent community project, not an official OpenAI or Oh My Pi product.

## What is implemented

- `/pet` starts the runtime on demand and shows the pet window.
- `/pet list`, `/pet select`, `/pet use <id>`, `/pet next`, and `/pet prev` switch installed pets.
- `/pet hide`, `/pet show`, and `/pet stop` control only the OMP pet process.
- `/pet events on|off` controls OMP event-driven animations.
- `/pet debug on|off|status` controls the persisted animation/reason overlay; it is off by default.
- `/pet play <state>` previews three complete animation cycles.
- `/pet import "<folder>"` is the explicit future import path; nothing is imported automatically.
- `/pet status` and `/pet doctor` expose runtime diagnostics.
- Activity bubbles use OMP's own tool intent as the title, a redacted command or safe task summary as the detail, and live elapsed time for active/background work.
- On Windows, activity cards use a native acrylic backdrop limited to their rounded outlines, with a neutral tint and a subtle inner highlight. Text remains opaque and the area around the pet stays transparent. Subagent titles are 12px with 11px detail text. Native title/icon decorations are removed and clipping survives hide/show. The main bubble stays 128px high to keep streaming updates steady. Commands show `已运行命令` without replacing the task title; replies show their beginning and clip to the available space.
- Multiple background/subagent bubbles start as one stacked summary showing the count. Click it (or press Enter/Space) to unfold the list; click its header again to stack the whole group. Each card can also expand its full title/detail. Both choices survive activity updates. The window grows upward around the pet and shrinks when cards collapse/disappear; long lists scroll within the monitor work area.
- Completed turns retain an `已完成` bubble until clicked or the next turn/session. Click or Enter/Space dismisses the reminder and attempts to return to the launching OMP terminal window on Windows. Dismissal survives heartbeat snapshots for the current runtime, even if Windows cannot focus the terminal; the next completed turn shows a new reminder. The owner PID and creation time are checked; shared Windows Terminal tabs are not selected individually. Completion is recovered from the live OMP session after runtime recreation, not archived after OMP exits.
- Hover jumps, dragging runs left/right, waking waves, and the pet looks toward the desktop cursor. Click toggles tasks; right click opens pet controls. Reduced-motion preferences are respected.
- Pet animations use Codex desktop's per-frame cadence instead of averaged FPS. See [`docs/ANIMATION_TIMING.md`](docs/ANIMATION_TIMING.md) for the versioned timing table and OMP playback policy.
- Each OMP session launches an isolated pet runtime. Its pet exits automatically with that session without stopping another session's pet.
- On Windows, native window regions follow the visible bubble cards and pet area, so
  blank space above and between them passes clicks through to the desktop below.

The OMP extension sends only versioned events whose source is `omp`. Every OMP session gets a private runtime descriptor and process. It does not read Codex state, expose hidden reasoning, or reuse a Codex event socket, so opening both desktop pets does not mix their event displays.

## Build and try the empty framework

Requirements: OMP 18+, Bun 1.3+, a current stable Rust toolchain, and WebView2 on Windows.

```powershell
git clone https://github.com/vavilonska/omp-pet.git
cd omp-pet
bun install
bun run build
bun run runtime:build
omp -e "C:\src\omp-pet\packages\omp-extension\src\index.ts"
```

Inside that OMP session, run `/pet`. Until a pet is imported, the window deliberately shows a small “No pet installed” placeholder.

For persistent loading, add the absolute extension path to the `extensions` array in the OMP user settings file, or place a built extension entry in an OMP `extensions` directory. Using `-e` is the least invasive development setup.

## Future pet package

When a Codex pet is finished, put a small `pet.json` beside its existing spritesheet:

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "Optional description",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp"
}
```

Then, and only then, import that staging folder:

```text
/pet import "F:\path\to\finished-pet-package"
```

The import copies the manifest and spritesheet into OMP Pet's own data directory. The Codex source folder remains unchanged. See [docs/PET_PACKAGE.md](docs/PET_PACKAGE.md) and [docs/omp-pet.schema.json](docs/omp-pet.schema.json).

On Windows, the default data directory is `%USERPROFILE%\.omp\omp-pet`. Keeping pet data under the OMP home avoids `LocalAppData` virtualization differences between OMP instances launched from normal shells and packaged desktop tools. Set `OMP_PET_DATA_DIR` to override it.

## Performance and isolation

- Animation runs at the source state's 5–10 fps, not a permanent 60 fps render loop.
- The canvas timer stops while the window is not visible.
- Each visible session pet uses one local process, a 250 ms state-expiry tick, and small batched HTTP messages.
- The API binds only to `127.0.0.1` on a random port and requires a random bearer token.
- Runtime discovery lives in a separate OMP data directory and never scans Codex pet folders.
- Session shutdown stops its owned pet immediately; a 15-second client lease also removes stale activity after crashes.

## Development checks

```powershell
bun run typecheck
bun test
cargo check --manifest-path runtime/src-tauri/Cargo.toml
bun run smoke:runtime
```

The smoke test uses an isolated temporary data directory and contains no character assets.

## Sealed Windows package

Build the self-contained Windows x64 package with:

```powershell
bun run package:windows
bun run verify:package
```

The output is written to `release/omp-pet-adapter-0.2.0-win32-x64.zip`, with a sibling SHA-256 file. After extracting it, run `install.cmd`. The installer verifies every payload checksum and copies the compiled extension plus runtime into the active OMP profile's `extensions/omp-pet` directory. OMP then discovers `/pet` on normal startup without `-e`, Bun workspaces, source files, administrator privileges, or symbolic links.

Use `install.ps1 -Profile <name>` and `uninstall.ps1 -Profile <name>` for a named OMP profile. Removing the adapter intentionally leaves imported pet data alone.

## License

Project code is MIT licensed. The bundled Noto Sans SC font retains its SIL Open Font License in `runtime/public/fonts/NotoSansSC-OFL.txt`. Imported pet artwork has its own terms and is not covered by the code license.
