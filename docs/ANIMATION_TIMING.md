# Codex pet animation timing reference

OMP Pet renders Codex-compatible v2 spritesheets with per-frame delays rather than a
single FPS value. This preserves the pauses and uneven cadence of the Codex desktop pet.

## Reference source

The frame definitions and interaction implementation were inspected on 2026-09-09
in locally installed Codex desktop `26.903.8094.0` (`app-initial`,
`avatar-mascot-button`, and `avatar-overlay-native-page` webview modules).
The per-frame timings below remain unchanged from the older reference.

## Per-frame delays

All values are milliseconds. Frame order is left to right within the state's spritesheet
row.

| State | Row | Per-frame delays (ms) | Cycle total |
| --- | ---: | --- | ---: |
| `idle` | 0 | `1680, 660, 660, 840, 840, 1920` | 6600 ms |
| `running-right` | 1 | `120, 120, 120, 120, 120, 120, 120, 220` | 1060 ms |
| `running-left` | 2 | `120, 120, 120, 120, 120, 120, 120, 220` | 1060 ms |
| `waving` | 3 | `140, 140, 140, 280` | 700 ms |
| `jumping` | 4 | `140, 140, 140, 140, 280` | 840 ms |
| `failed` | 5 | `140, 140, 140, 140, 140, 140, 140, 240` | 1220 ms |
| `waiting` | 6 | `150, 150, 150, 150, 150, 260` | 1010 ms |
| `running` | 7 | `120, 120, 120, 120, 120, 220` | 820 ms |
| `review` | 8 | `150, 150, 150, 150, 150, 280` | 1030 ms |

The long `idle` delays are intentional. They are the main reason a fixed-FPS
implementation looks much busier than the Codex desktop pet.

## OMP playback policy

- Every non-idle animation plays three complete cycles, then settles to idle.
  Running: 2460 ms; waiting: 3030 ms; failed: 3660 ms; review: 3090 ms;
  waving: 2100 ms; jumping: 2520 ms; directional running: 3180 ms.
- Idle repeats continuously with the original long per-frame pauses.
- Hover selects jumping; horizontal dragging selects left/right running at a
  four-pixel movement threshold. Release/cancel clears the drag override.
- Initial selection and reopening a hidden pet greet with waving when idle.
- Sixteen-direction gaze follows the desktop cursor only within a 240 CSS pixel
  radius of the pet center, in idle/running/waving. Outside that circle gaze is
  cleared and the normal animation resumes. The center dead zone is one CSS pixel. Hover and drag
  override gaze. OMP has no Codex computer-use/caret event source: ordinary OS
  cursor tracking is the explicit OMP equivalent, not a Codex event subscription.
- Reduced-motion mode shows the first frame and disables CSS transitions.
- Bubble updates and repeated identical state payloads do not reset frame timing.
- Main and background bubbles remain separate from animation playback. The final
  main bubble persists as `已完成`; error bubbles retain their finite deadline before completion is shown.
  Active operations keep their bubbles and elapsed timers after animation settles.
- Click/Enter/Space toggles task bubbles. Right click or Shift+F10 opens the pet
  menu (switch pets, preview waving/jumping, hide). Escape closes the menu.
  The main bubble stays 72px high and shows the beginning of replies without hover expansion.
  Background details expand on hover. The main bubble has no dismiss button; clicking
  a completed bubble returns to the launching OMP terminal window. A new bubble becomes visible.
- Native hit regions include the menu and exclude hidden bubbles and blank gaps.

## Host integration boundary

This ports sprite interactions to the isolated OMP runtime. Codex account/task
navigation, Quick Chat, voice, and approval submission are Codex application
features, not spritesheet actions. This adapter does not impersonate those APIs;
OMP approvals and answers continue to be handled in the owning OMP session.

## Implementation and validation

- Frame table: `packages/core/src/codex-assets.ts`
- Deterministic playback/gestures: `runtime/src/interaction.ts`
- Renderer and local controls: `runtime/src/main.ts`
- TS/Rust event windows: `packages/core/src/reducer.ts`, `runtime/src-tauri/src/reducer.rs`
- Gesture/frame boundary tests: `runtime/test/interaction.test.ts`
- Release reducer/hit-region tests: `cargo test --release --manifest-path runtime/src-tauri/Cargo.toml --lib`

No desktop interaction testing was performed for this change, as requested.

## Activity recovery (2026-09-09)

The extension retains a per-session projection while disconnected. Initial attach,
phase changes, and five-second heartbeats send a `client.snapshot` containing live
agent state, bounded tool/approval metadata and background jobs. No streamed text
or reasoning is forwarded. Reconnection retries on the heartbeat and replays the
current snapshot, including after queue overflow. Session switches replace only
that extension instance's old session. HTTP fetches have abort deadlines.

Finite error/approval feedback returns to an active tool/agent bubble on expiry.
A completed task retains its completion timestamp in idle snapshots and restores
the completion bubble after runtime reconnect. New turns and session switches clear it.
Active bubbles cannot be silently dismissed by clicking the pet; the dismiss button is removed. Compaction and retry transitions
and bounded streaming phases are observed. Both the extension and runtime must
be reloaded for this update (restart OMP, then `/pet`).
