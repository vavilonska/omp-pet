import { STANDARD_ANIMATIONS, type PetAnimationState } from "@omp-pet/core";

// CSS pixels, independent of Windows display scaling.
export const GAZE_RADIUS_PX = 240;

export function lookDirection(x: number, y: number): number | null {
  const distance = Math.hypot(x, y);
  if (!Number.isFinite(distance) || distance <= 1 || distance > GAZE_RADIUS_PX) return null;
  return (Math.round((((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360) / 22.5) * 22.5) % 360;
}

export function interactionState(base: PetAnimationState, hovered: boolean,
  drag: PetAnimationState | null, greeting: boolean): PetAnimationState {
  return drag ?? (hovered ? "jumping" : greeting && base === "idle" ? "waving" : base);
}

// Time-based sampling keeps bubble updates and cursor polling from resetting frames.
export function playbackFrame(state: PetAnimationState, elapsed: number, reduced: boolean) {
  const definition = STANDARD_ANIMATIONS.find(item => item.state === state) ?? STANDARD_ANIMATIONS[0]!;
  if (reduced) return { row: definition.row, column: 0, delay: null };
  const cycle = definition.frameDurationsMs.reduce((a, b) => a + b, 0);
  if (state !== "idle" && elapsed >= cycle * 3) return playbackFrame("idle", elapsed - cycle * 3, false);
  let offset = Math.max(0, elapsed) % cycle;
  for (let column = 0; column < definition.frames; column++) {
    const duration = definition.frameDurationsMs[column]!;
    if (offset < duration) return { row: definition.row, column, delay: duration - offset };
    offset -= duration;
  }
  return { row: definition.row, column: 0, delay: cycle };
}

export class DragGesture {
  moved = false;
  direction: "running-left" | "running-right" | null = null;
  private lastX: number;
  constructor(readonly x: number, readonly y: number) { this.lastX = x; }
  update(x: number, y: number): boolean {
    if (!this.moved && Math.abs(x - this.x) < 4 && Math.abs(y - this.y) < 4) return false;
    this.moved = true;
    const delta = x - this.lastX;
    if (Math.abs(delta) >= 4) {
      this.direction = delta > 0 ? "running-right" : "running-left";
      this.lastX = x;
    }
    return true;
  }
}
