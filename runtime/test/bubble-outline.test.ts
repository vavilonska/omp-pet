import { expect, test } from "bun:test";
import { outlineGeometry, OUTLINE_WIDTH } from "../src/bubble-outline";

test("fractional layout and DPI keep the complete stroke on physical pixel bounds", () => {
  for (const dpr of [1, 1.25, 1.5, 2]) {
    for (const box of [
      { left: 8, top: 8.90625, width: 280, height: 63.09375 },
      { left: 14.2, top: 20.4, width: 267.6, height: 34 },
      { left: 8, top: -22.59375, width: 265, height: 97.59375 },
    ]) {
      const shape = outlineGeometry(box, 32, dpr);
      const left = box.left + shape.x - OUTLINE_WIDTH / 2;
      const top = box.top + shape.y - OUTLINE_WIDTH / 2;
      const right = box.left + shape.x + shape.width + OUTLINE_WIDTH / 2;
      const bottom = box.top + shape.y + shape.height + OUTLINE_WIDTH / 2;
      for (const edge of [left, top, right, bottom]) {
        expect(edge * dpr).toBeCloseTo(Math.round(edge * dpr), 6);
      }
      expect(left).toBeGreaterThanOrEqual(box.left - 1e-7);
      expect(top).toBeGreaterThanOrEqual(box.top - 1e-7);
      expect(right).toBeLessThanOrEqual(box.left + box.width + 1e-7);
      expect(bottom).toBeLessThanOrEqual(box.top + box.height + 1e-7);
    }
  }
});

test("expanded cards keep their original radius and uniform stroke width", () => {
  for (const radius of [17, 32]) {
    const compact = outlineGeometry({ left: 8, top: 8, width: 280, height: radius * 2 }, radius, 1);
    const expanded = outlineGeometry({ left: 8, top: 8, width: 280, height: radius * 2 + 80 }, radius, 1);
    expect(expanded.rx).toBe(compact.rx);
    expect(expanded.rx + OUTLINE_WIDTH / 2).toBe(radius);
    expect(expanded.height - compact.height).toBe(80);
  }
});
