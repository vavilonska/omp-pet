import { expect, test } from "bun:test";
import { STANDARD_ANIMATIONS, PetEventReducer } from "@omp-pet/core";
import { DragGesture, interactionState, lookDirection, playbackFrame } from "../src/interaction";

test("all non-idle actions play three full cycles before idle", () => {
  for (const action of STANDARD_ANIMATIONS.filter(item => item.state !== "idle")) {
    const total = action.frameDurationsMs.reduce((a, b) => a + b, 0) * 3;
    expect(playbackFrame(action.state, total - 1, false)).toMatchObject({ row: action.row, column: action.frames - 1 });
    expect(playbackFrame(action.state, total, false)).toMatchObject({ row: 0, column: 0 });
    const reducer = new PetEventReducer();
    reducer.setManual(action.state, 10);
    expect(reducer.state(10 + total - 1).animation).toBe(action.state);
    expect(reducer.state(10 + total).animation).toBe("idle");
  }
});

test("reduced motion selects first frame without scheduling animation", () => {
  expect(playbackFrame("jumping", 900, true)).toEqual({ row: 4, column: 0, delay: null });
});

test("hover and directional drag override greeting and task state", () => {
  expect(interactionState("idle", false, null, true)).toBe("waving");
  expect(interactionState("waiting", true, null, true)).toBe("jumping");
  expect(interactionState("waiting", true, "running-left", true)).toBe("running-left");
  expect(interactionState("waiting", false, null, false)).toBe("waiting");
});

test("click jitter stays a click; drag follows reversals and vertical movement", () => {
  const gesture = new DragGesture(100, 100);
  expect(gesture.update(103, 103)).toBe(false);
  expect(gesture.moved).toBe(false);
  expect(gesture.update(108, 100)).toBe(true);
  expect(gesture.direction).toBe("running-right");
  gesture.update(99, 100);
  expect(gesture.direction).toBe("running-left");
  const vertical = new DragGesture(0, 0);
  expect(vertical.update(0, 5)).toBe(true);
  expect(vertical.moved).toBe(true);
});

test("sixteen directions wrap around north and retain center dead zone", () => {
  for (let direction = 0; direction < 360; direction += 22.5) {
    const radians = direction * Math.PI / 180;
    expect(lookDirection(Math.sin(radians) * 100, -Math.cos(radians) * 100)).toBe(direction);
  }
  expect(lookDirection(0, 1)).toBeNull();
  expect(lookDirection(-0.1, -100)).toBe(0);
});

test("repeated samples do not restart long idle pauses or action cadence", () => {
  expect(playbackFrame("idle", 1_679, false)).toMatchObject({ column: 0, delay: 1 });
  expect(playbackFrame("idle", 1_680, false)).toMatchObject({ column: 1, delay: 660 });
  expect(playbackFrame("running", 2_460, false)).toMatchObject({ row: 0, column: 0 });
});


test("gaze releases outside the 240 CSS pixel radius, including diagonals", () => {
  expect(lookDirection(240, 0)).toBe(90);
  expect(lookDirection(240.1, 0)).toBeNull();
  expect(lookDirection(180, 180)).toBeNull();
  expect(lookDirection(0, -500)).toBeNull();
  expect(lookDirection(100, 0)).toBe(90);
});
