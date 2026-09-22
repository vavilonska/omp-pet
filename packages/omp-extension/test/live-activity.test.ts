import { expect, test } from "bun:test";
import { LiveActivity } from "../src/live-activity";

test("completed turn survives idle snapshots and clears on a new turn", () => {
  const live = new LiveActivity();
  live.apply("agent.started", {}, 10);
  live.apply("agent.completed", {}, 20);
  expect(live.snapshot(true, 60_000)).toMatchObject({ active: false, completedAt: 20 });
  live.apply("agent.started", {}, 60_001);
  expect(live.snapshot(false, 60_002).completedAt).toBeNull();
});

test("projection retains disconnected lifecycle, clears completed tools and keeps original timer", () => {
  const live = new LiveActivity();
  live.apply("agent.started", {}, 10);
  live.apply("tool.started", { toolCallId: "a", title: "read" }, 20);
  expect(live.snapshot(false, 30)).toMatchObject({ active: true, startedAt: 10, tools: [{ id: "a", title: "read", startedAt: 20 }] });
  live.apply("tool.completed", { toolCallId: "a" }, 40);
  expect(live.snapshot(false, 50).tools).toEqual([]);
  expect(live.snapshot(true, 60).active).toBe(false);
});
test("late connection recovers active work and compaction survives streaming idle", () => {
  const live = new LiveActivity();
  expect(live.snapshot(false, 100)).toMatchObject({ active: true, startedAt: 100 });
  live.phase = "正在整理上下文";
  expect(live.snapshot(true, 200).active).toBe(true);
  live.phase = "正在处理任务";
  expect(live.snapshot(true, 300).active).toBe(false);
});
