import { describe, expect, test } from "bun:test";
import {
  PET_PROTOCOL_VERSION,
  PetEventReducer,
  animationFor,
  createPetEvent,
  normalizeCodexPet,
  parsePetCommand,
  parsePetManifest,
  tokenizeCommandLine,
  validateSpritesheetDimensions,
} from "../src";

const manifest = {
  id: "test-pet",
  displayName: "Test Pet",
  description: "Temporary test metadata only",
  spriteVersionNumber: 2 as const,
  spritesheetPath: "spritesheet.webp",
};

describe("Codex asset compatibility", () => {
  test("normalizes the v2 8x11 atlas contract", () => {
    const result = parsePetManifest(manifest);
    expect(result.ok).toBe(true);
    expect(result.pet?.atlas).toEqual({
      columns: 8,
      rows: 11,
      cellWidth: 192,
      cellHeight: 208,
      width: 1536,
      height: 2288,
    });
    expect(result.pet?.lookDirections).toHaveLength(16);
  });

  test("rejects paths that can leave a package", () => {
    const result = parsePetManifest({ ...manifest, spritesheetPath: "../secret.webp" });
    expect(result.ok).toBe(false);
  });

  test("validates exact sheet dimensions", () => {
    const pet = normalizeCodexPet(manifest);
    expect(validateSpritesheetDimensions(pet, 1536, 2288).ok).toBe(true);
    expect(validateSpritesheetDimensions(pet, 1536, 1872).ok).toBe(false);
  });

  test("maps look directions to the two v2 rows", () => {
    const pet = normalizeCodexPet(manifest);
    expect(animationFor(pet, "look", 90)).toEqual({ degrees: 90, row: 9, column: 4 });
    expect(animationFor(pet, "look", 270)).toEqual({ degrees: 270, row: 10, column: 4 });
  });

  test("uses Codex desktop's exact per-frame animation cadence", () => {
    const pet = normalizeCodexPet(manifest);
    expect(animationFor(pet, "idle")).toMatchObject({
      frameDurationsMs: [1_680, 660, 660, 840, 840, 1_920],
    });
    expect(animationFor(pet, "running")).toMatchObject({
      frameDurationsMs: [120, 120, 120, 120, 120, 220],
    });
    expect(animationFor(pet, "waiting")).toMatchObject({
      frameDurationsMs: [150, 150, 150, 150, 150, 260],
    });
  });
});

describe("/pet command parsing", () => {
  test("defaults to show", () => {
    expect(parsePetCommand(" ")).toEqual({ name: "show", args: [] });
  });

  test("supports quoted Windows paths", () => {
    expect(tokenizeCommandLine('import "F:\\My Pets\\Luna"')).toEqual([
      "import",
      "F:\\My Pets\\Luna",
    ]);
  });

  test("reports unclosed quotes", () => {
    expect(() => tokenizeCommandLine('import "unfinished')).toThrow();
  });
});

describe("event reducer", () => {
  const event = (
    type: Parameters<typeof createPetEvent>[0]["type"],
    timestamp: number,
    payload?: Record<string, unknown>,
  ) =>
    createPetEvent({
      instanceId: "omp-a",
      sessionId: "session-a",
      sequence: timestamp,
      timestamp,
      type,
      ...(payload ? { payload } : {}),
    });

  test("aggregates work and returns to review then idle", () => {
    const reducer = new PetEventReducer({ reviewDurationMs: 100 });
    reducer.apply(event("agent.started", 10));
    expect(reducer.state(20).animation).toBe("running");
    reducer.apply(event("agent.completed", 30));
    expect(reducer.state(40).animation).toBe("review");
    expect(reducer.state(131).animation).toBe("idle");
  });

  test("honors configured running and waiting playback windows", () => {
    const reducer = new PetEventReducer({ runningCycleMs: 75, waitingCycleMs: 100 });
    reducer.apply(event("agent.started", 10));
    expect(reducer.state(20).animation).toBe("running");
    expect(reducer.state(86).animation).toBe("idle");

    reducer.apply(event("tool.started", 90, { toolCallId: "tool-1" }));
    expect(reducer.state(100).animation).toBe("running");
    expect(reducer.state(166).animation).toBe("idle");

    reducer.apply(event("approval.requested", 170, { toolCallId: "tool-1" }));
    expect(reducer.state(180).animation).toBe("waiting");
    expect(reducer.state(271).animation).toBe("idle");
    expect(reducer.snapshot(272).pendingApprovals).toBe(1);
  });

  test("manual running and waiting honor configured playback windows", () => {
    const reducer = new PetEventReducer({ runningCycleMs: 75, waitingCycleMs: 100 });
    reducer.setManual("running", 10);
    expect(reducer.state(84).animation).toBe("running");
    expect(reducer.state(85).animation).toBe("idle");
    reducer.setManual("waiting", 100);
    expect(reducer.state(199).animation).toBe("waiting");
    expect(reducer.state(200).animation).toBe("idle");
  });

  test("emits titled OMP bubbles with sticky active work", () => {
    const reducer = new PetEventReducer();
    reducer.apply(event("agent.started", 10));
    expect(reducer.state(20).bubble?.title).toBe("OMP 正在处理");
    reducer.apply(event("tool.started", 30, {
      toolCallId: "tool-1",
      toolName: "read",
      title: "检查配置文件",
      detail: "F:/repo/config.json",
      startedAt: 25,
    }));
    expect(reducer.state(40).bubble).toMatchObject({
      title: "检查配置文件",
      detail: "F:/repo/config.json",
      startedAt: 25,
      expiresAt: null,
    });
    reducer.apply(event("approval.requested", 50, { toolCallId: "tool-1", toolName: "bash" }));
    expect(reducer.state(10_000).bubble).toMatchObject({
      title: "需要批准",
      detail: "正在运行命令",
      expiresAt: null,
    });
    reducer.apply(event("approval.resolved", 10_010, {
      toolCallId: "tool-1",
      toolName: "bash",
      approved: true,
    }));
    expect(reducer.state(10_020).bubble?.title).toBe("已批准，继续执行");
  });

  test("keeps the command bubble when a tool completes during an active turn", () => {
    const reducer = new PetEventReducer();
    reducer.apply(event("agent.started", 10, { title: "检查项目" }));
    reducer.apply(event("tool.started", 20, {
      toolCallId: "tool-1",
      title: "运行测试",
      detail: "> bun test",
    }));
    reducer.apply(event("tool.completed", 30, { toolCallId: "tool-1" }));
    expect(reducer.state(40).bubble).toMatchObject({
      title: "运行测试",
      detail: "> bun test",
      expiresAt: null,
    });

    reducer.apply(event("agent.completed", 50));
    expect(reducer.state(60).bubble).toMatchObject({
      title: "已完成",
      detail: "点击返回 OMP 并关闭提示",
      startedAt: null,
      expiresAt: null,
    });
    expect(reducer.state(2_549).animation).toBe("review");
    expect(reducer.state(2_550)).toMatchObject({ animation: "review", bubble: { kind: "completed" } });
    expect(reducer.state(3_140).animation).toBe("idle");
  });

  test("new turns replace completed intent and do not resume the old review", () => {
    const reducer = new PetEventReducer();
    reducer.apply(event("tool.started", 10, { toolCallId: "old", title: "旧任务" }));
    reducer.apply(event("agent.completed", 20));
    reducer.apply(event("agent.started", 30));
    expect(reducer.state(40).bubble?.title).toBe("OMP 正在处理");
    expect(reducer.state(2_490)).toMatchObject({ animation: "idle", bubble: { expiresAt: null } });
  });

  test("completion clears stale approval feedback but preserves background work", () => {
    const reducer = new PetEventReducer({ reviewDurationMs: 100 });
    reducer.apply(event("approval.requested", 10, { toolCallId: "approval" }));
    reducer.apply(event("background.snapshot", 20, { jobs: [{ id: "job", title: "后台任务" }] }));
    reducer.apply(event("agent.completed", 30));
    expect(reducer.state(31).animation).toBe("review");
    expect(reducer.snapshot(2_530)).toMatchObject({
      pendingApprovals: 0,
      backgroundJobs: 1,
      state: { animation: "idle", bubble: { kind: "completed" } },
    });
    expect(reducer.state(130).backgroundBubbles).toHaveLength(1);
  });

  test("completion preserves finite failure feedback without making it permanent", () => {
    const reducer = new PetEventReducer();
    reducer.apply(event("tool.failed", 10, { toolCallId: "failed" }));
    reducer.apply(event("agent.completed", 20));
    expect(reducer.state(30)).toMatchObject({
      animation: "failed", bubble: { kind: "error", expiresAt: 3_010 },
    });
    expect(reducer.state(3_010)).toMatchObject({ animation: "failed", bubble: { kind: "completed" } });
    expect(reducer.state(3_670).animation).toBe("idle");
  });

  test("a completed or restarted client leaves another client's active tool and approval visible", () => {
    for (const type of ["tool.started", "approval.requested"] as const) {
      const reducer = new PetEventReducer();
      reducer.apply(event("agent.started", 10));
      reducer.apply({ ...event(type, 20, { toolCallId: "other", title: "另一任务" }), instanceId: "omp-b" });
      const active = reducer.state(21).bubble;
      reducer.apply(event("agent.completed", 30));
      reducer.apply(event("agent.started", 40));
      expect(reducer.state(5_000).bubble).toEqual(active);
      expect(active?.expiresAt).toBeNull();
    }
  });

  test("tool handoff retains the actual bubble owner across another client's completion", () => {
    const reducer = new PetEventReducer();
    reducer.apply({ ...event("tool.started", 10, { toolCallId: "other", title: "另一任务" }), instanceId: "omp-b" });
    reducer.apply(event("tool.started", 20, { toolCallId: "mine", title: "当前任务" }));
    reducer.apply(event("tool.completed", 30, { toolCallId: "mine" }));
    reducer.apply(event("agent.completed", 40));
    expect(reducer.state(5_000).bubble).toMatchObject({ title: "另一任务", startedAt: 10, expiresAt: null });
  });

  test("never replaces the last intent with a step-complete fallback", () => {
    const reducer = new PetEventReducer();
    reducer.apply(event("tool.started", 10, {
      toolCallId: "tool-1",
      title: "读取配置",
      detail: "config.json",
    }));
    reducer.apply(event("tool.completed", 20, { toolCallId: "tool-1" }));
    expect(reducer.state(30).bubble?.title).toBe("读取配置");
  });

  test("tracks background job titles and start times", () => {
    const reducer = new PetEventReducer();
    reducer.apply(event("background.snapshot", 10, {
      jobs: [{ id: "job-1", type: "bash", title: "训练第十五轮", startedAt: 5 }],
    }));
    expect(reducer.state(20)).toMatchObject({
      animation: "running",
      bubble: null,
      backgroundBubbles: [{
          title: "训练第十五轮",
          detail: "后台 bash 任务",
          startedAt: 5,
          background: true,
          expiresAt: null,
      }],
    });
  });

  test("stacks background bubbles without replacing the main intent", () => {
    const reducer = new PetEventReducer();
    reducer.apply(event("agent.started", 10));
    reducer.apply(event("tool.started", 20, {
      toolCallId: "tool-1",
      title: "检查当前步骤",
      detail: "> bun test",
    }));
    reducer.apply(event("background.snapshot", 30, {
      jobs: [
        { id: "job-1", type: "bash", title: "后台训练", startedAt: 21 },
        { id: "job-2", type: "task", title: "后台审查", startedAt: 22 },
      ],
    }));
    const state = reducer.state(40);
    expect(state.bubble?.title).toBe("检查当前步骤");
    expect(state.backgroundBubbles.map(item => item.title)).toEqual(["后台训练", "后台审查"]);
  });

  test("prioritizes failure and approval over running", () => {
    const reducer = new PetEventReducer({ failedDurationMs: 100, waitingCycleMs: 1_000 });
    reducer.apply(event("agent.started", 10));
    reducer.apply(event("approval.requested", 20, { toolCallId: "tool-1" }));
    expect(reducer.state(30).animation).toBe("waiting");
    reducer.apply(event("tool.failed", 40, { toolCallId: "tool-1" }));
    expect(reducer.state(50).animation).toBe("failed");
    expect(reducer.state(141).animation).toBe("waiting");
  });

  test("ignores non-client events when disabled", () => {
    const reducer = new PetEventReducer();
    reducer.apply(event("agent.started", 5));
    reducer.setEventsEnabled(false);
    reducer.apply(event("agent.started", 10));
    expect(reducer.state(20).animation).toBe("idle");
    reducer.setEventsEnabled(true);
    expect(reducer.state(21).animation).toBe("idle");
  });

  test("creates versioned source-isolated envelopes", () => {
    const value = event("client.hello", 10);
    expect(value.protocolVersion).toBe(PET_PROTOCOL_VERSION);
    expect(value.source).toBe("omp");
  });
});
