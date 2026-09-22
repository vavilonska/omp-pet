import { expect, test } from "bun:test";
import { clipRect, physicalRect, physicalRegion } from "../src/hit-region";

test("native regions cover fractional CSS boundaries at Windows display scales", () => {
  const rect = { left: 8.2, top: 180.1, right: 224.2, bottom: 250.3 };
  expect(physicalRect(rect, 1)).toEqual({ left: 8, top: 180, right: 225, bottom: 251 });
  expect(physicalRect(rect, 1.25)).toEqual({ left: 10, top: 225, right: 281, bottom: 313 });
  expect(physicalRect(rect, 2)).toEqual({ left: 16, top: 360, right: 449, bottom: 501 });
});

test("scrolled cards only capture clicks inside their visible list viewport", () => {
  const viewport = { left: 8, top: 8, right: 288, bottom: 200 };
  expect(clipRect({ left: 8, top: -50, right: 288, bottom: 40 }, viewport))
    .toEqual({ left: 8, top: 8, right: 288, bottom: 40 });
  expect(clipRect({ left: 8, top: 180, right: 288, bottom: 270 }, viewport))
    .toEqual({ left: 8, top: 180, right: 288, bottom: 200 });
  expect(clipRect({ left: 8, top: 210, right: 288, bottom: 270 }, viewport)).toBeNull();
});

test("rounded native outlines preserve full card geometry and scale their clip separately", () => {
  const card = { left: 8, top: -40, right: 288, bottom: 180 };
  const clip = { left: 8, top: 8, right: 288, bottom: 100 };
  expect(physicalRegion(card, 1.25, 18, clip)).toEqual({
    left: 10, top: -50, right: 360, bottom: 225, radius: 22,
    clip: { left: 10, top: 10, right: 360, bottom: 125 },
  });
});
