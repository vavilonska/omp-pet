# Pet package contract

The adapter intentionally separates character art from runtime code. A pet author only needs a folder containing `pet.json` and one already-finished Codex-compatible spritesheet.

## Manifest fields

| Field | Requirement |
| --- | --- |
| `id` | Lowercase stable ID matching `[a-z0-9][a-z0-9._-]{0,63}`. |
| `displayName` | Non-empty name shown by `/pet list` and `/pet select`. |
| `description` | Optional human-readable description. |
| `spriteVersionNumber` | `1` for the 8×9 atlas or `2` for the 8×11 atlas. |
| `spritesheetPath` | Relative path inside the package. Absolute paths and `..` are rejected. |

Unknown manifest fields are ignored so a Codex pet can carry extra metadata without an OMP-specific fork.

## Atlas contract

Every cell is 192×208 pixels and every sheet has eight columns.

| Row | State | Frames |
| ---: | --- | ---: |
| 0 | idle | 6 |
| 1 | running-right | 8 |
| 2 | running-left | 8 |
| 3 | waving | 4 |
| 4 | jumping | 5 |
| 5 | failed | 8 |
| 6 | waiting | 6 |
| 7 | running | 6 |
| 8 | review | 6 |
| 9–10 | 16 look directions at 22.5° intervals, v2 only | 8 per row |

- v1 must be exactly 1536×1872.
- v2 must be exactly 1536×2288.
- The v2 neutral look frame remains row 0, column 6.

The importer verifies the manifest, canonical path containment, image readability, and exact dimensions before copying anything. Existing installed pets are not replaced unless `/pet import <folder> --force` is explicitly used.

## Why this stays reusable

The animation table and validation logic live in `@omp-pet/core`; the OMP extension contains no character-specific code. A new Codex pet therefore needs metadata, not a new adapter. If a future Codex atlas version appears, add a normalizer for that version while leaving OMP events and `/pet` commands unchanged.

