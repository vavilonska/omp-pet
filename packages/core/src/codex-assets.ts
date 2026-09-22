import type { PetAnimationState } from "./protocol";

export const CELL_WIDTH = 192;
export const CELL_HEIGHT = 208;
export const ATLAS_COLUMNS = 8;

export interface PetManifest {
  id: string;
  displayName: string;
  description: string;
  spriteVersionNumber: 1 | 2;
  spritesheetPath: string;
}

export interface AnimationDefinition {
  state: Exclude<PetAnimationState, "look">;
  row: number;
  frames: number;
  frameDurationsMs: number[];
  loop: boolean;
}

export interface LookDirectionDefinition {
  degrees: number;
  row: number;
  column: number;
}

export interface NormalizedPet {
  manifest: PetManifest;
  atlas: {
    columns: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
    width: number;
    height: number;
  };
  animations: AnimationDefinition[];
  lookDirections: LookDirectionDefinition[];
  neutralLookFrame: { row: number; column: number } | null;
}

export interface AssetValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  pet?: NormalizedPet;
}

export const STANDARD_ANIMATIONS: readonly AnimationDefinition[] = [
  { state: "idle", row: 0, frames: 6, frameDurationsMs: [1_680, 660, 660, 840, 840, 1_920], loop: true },
  { state: "running-right", row: 1, frames: 8, frameDurationsMs: [120, 120, 120, 120, 120, 120, 120, 220], loop: true },
  { state: "running-left", row: 2, frames: 8, frameDurationsMs: [120, 120, 120, 120, 120, 120, 120, 220], loop: true },
  { state: "waving", row: 3, frames: 4, frameDurationsMs: [140, 140, 140, 280], loop: true },
  { state: "jumping", row: 4, frames: 5, frameDurationsMs: [140, 140, 140, 140, 280], loop: true },
  { state: "failed", row: 5, frames: 8, frameDurationsMs: [140, 140, 140, 140, 140, 140, 140, 240], loop: true },
  { state: "waiting", row: 6, frames: 6, frameDurationsMs: [150, 150, 150, 150, 150, 260], loop: true },
  { state: "running", row: 7, frames: 6, frameDurationsMs: [120, 120, 120, 120, 120, 220], loop: true },
  { state: "review", row: 8, frames: 6, frameDurationsMs: [150, 150, 150, 150, 150, 280], loop: true },
];

export const LOOK_DIRECTIONS: readonly LookDirectionDefinition[] = Array.from(
  { length: 16 },
  (_, index) => ({
    degrees: index * 22.5,
    row: index < 8 ? 9 : 10,
    column: index % 8,
  }),
);

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function hasPathTraversal(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split("/").some(segment => segment === "..")
  );
}

export function parsePetManifest(value: unknown): AssetValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!value || typeof value !== "object") {
    return { ok: false, errors: ["pet.json must contain an object"], warnings };
  }

  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : "";
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const spritesheetPath =
    typeof raw.spritesheetPath === "string" ? raw.spritesheetPath.trim() : "";
  const version = raw.spriteVersionNumber;

  if (!SAFE_ID.test(id)) errors.push("id must match [a-z0-9][a-z0-9._-]{0,63}");
  if (!displayName) errors.push("displayName is required");
  if (version !== 1 && version !== 2) errors.push("spriteVersionNumber must be 1 or 2");
  if (!spritesheetPath) errors.push("spritesheetPath is required");
  if (spritesheetPath && hasPathTraversal(spritesheetPath)) {
    errors.push("spritesheetPath must be a safe relative path inside the pet package");
  }
  if (!description) warnings.push("description is empty");
  if (errors.length > 0 || (version !== 1 && version !== 2)) {
    return { ok: false, errors, warnings };
  }

  const manifest: PetManifest = {
    id,
    displayName,
    description,
    spriteVersionNumber: version,
    spritesheetPath,
  };

  return {
    ok: true,
    errors,
    warnings,
    pet: normalizeCodexPet(manifest),
  };
}

export function normalizeCodexPet(manifest: PetManifest): NormalizedPet {
  const rows = manifest.spriteVersionNumber === 2 ? 11 : 9;
  return {
    manifest,
    atlas: {
      columns: ATLAS_COLUMNS,
      rows,
      cellWidth: CELL_WIDTH,
      cellHeight: CELL_HEIGHT,
      width: ATLAS_COLUMNS * CELL_WIDTH,
      height: rows * CELL_HEIGHT,
    },
    animations: STANDARD_ANIMATIONS.map(item => ({
      ...item,
      frameDurationsMs: [...item.frameDurationsMs],
    })),
    lookDirections:
      manifest.spriteVersionNumber === 2 ? LOOK_DIRECTIONS.map(item => ({ ...item })) : [],
    neutralLookFrame: manifest.spriteVersionNumber === 2 ? { row: 0, column: 6 } : null,
  };
}

export function validateSpritesheetDimensions(
  pet: NormalizedPet,
  width: number,
  height: number,
): AssetValidationResult {
  const errors: string[] = [];
  if (width !== pet.atlas.width) {
    errors.push(`spritesheet width must be ${pet.atlas.width}, received ${width}`);
  }
  if (height !== pet.atlas.height) {
    errors.push(`spritesheet height must be ${pet.atlas.height}, received ${height}`);
  }
  return { ok: errors.length === 0, errors, warnings: [], pet };
}

export function animationFor(
  pet: NormalizedPet,
  state: PetAnimationState,
  directionDegrees?: number,
): AnimationDefinition | LookDirectionDefinition {
  if (state === "look" && pet.lookDirections.length > 0) {
    const normalized = ((directionDegrees ?? 0) % 360 + 360) % 360;
    const index = Math.round(normalized / 22.5) % 16;
    return pet.lookDirections[index]!;
  }
  return pet.animations.find(item => item.state === state) ?? pet.animations[0]!;
}
