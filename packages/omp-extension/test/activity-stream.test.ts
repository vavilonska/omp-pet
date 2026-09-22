import { expect, test } from "bun:test";
import { messageActivity, toolActivity } from "../src/activity";
import { LiveActivity } from "../src/live-activity";

test("only visible thinking is forwarded, never plain text or IRC envelopes", () => {
  expect(messageActivity({ role: "assistant", content: [
    { type: "thinking", thinking: "Reviewing results", signature: "hidden" },
    { type: "text", text: "Running agent DesignSplit..." },
  ] })).toEqual({ detail: "Reviewing results", summary: true });
  for (const role of ["assistant", "tool", "user", "custom"]) {
    expect(messageActivity({ role, content: [{ type: "text", text: "Running agent DesignSplit..." }] })).toEqual({});
  }
});

test("streamed intent matches the OMP working title and command becomes detail", () => {
  expect(messageActivity({ role: "assistant", content: [
    { type: "thinking", thinking: "Preparing tests" },
    { type: "toolCall", name: "bash", arguments: { i: "交回知识闭环回归中的两个失败", command: "bun test" } },
  ] })).toEqual({ title: "交回知识闭环回归中的两个失败", detail: "已运行命令" });
});

test("title survives messages, tool completion and reconnect; new turns reset content", () => {
  const live = new LiveActivity();
  live.apply("agent.started", {}, 10);
  live.apply("tool.started", { toolCallId: "a", ...toolActivity("bash", { command: "bun test" }, "检查回归") }, 20);
  live.update(undefined, "64 passed");
  expect(live.snapshot(false, 30)).toMatchObject({ title: "检查回归", detail: "已运行命令", tools: [{ title: "检查回归", detail: "已运行命令" }] });
  live.apply("tool.completed", { toolCallId: "a" }, 40);
  live.update(undefined, "Checking legacy fixtures", true);
  expect(live.snapshot(false, 50)).toMatchObject({ title: "检查回归", detail: "Checking legacy fixtures", tools: [], startedAt: 10 });
  live.apply("agent.completed", {}, 60);
  live.apply("agent.started", {}, 70);
  expect(live.snapshot(false, 80)).toMatchObject({ title: "正在处理任务", detail: null });
});


test("partial command arguments never change the fixed detail", () => {
  for (const name of ["bash", "shell", "exec", "python", "eval", "powershell", "exec_command", "irc", "hub", "task", "grep", "read", "custom_tool"]) {
    for (const command of ["", "bun", "bun test --verbose"]) {
      expect(messageActivity({ role: "assistant", content: [{ type: "toolCall", name, arguments: { command, code: command } }] }).detail).toBe("已运行命令");
    }
  }
});


test("subagent launch keeps only the parent's intent and a neutral dispatch label", () => {
  expect(messageActivity({ role: "assistant", content: [{ type: "toolCall", name: "task",
    arguments: { i: "按依赖顺序实施隔离验证", task: "Child private task content", name: "DesignSplit" },
  }] })).toEqual({ title: "按依赖顺序实施隔离验证", detail: "已运行命令" });
});

test("summary resumes after tools and survives snapshots without command text", () => {
  const live = new LiveActivity();
  live.apply("agent.started");
  live.apply("tool.started", { toolCallId: "irc", ...toolActivity("irc", { message: "Running agent A..." }, "协调任务") });
  expect(live.snapshot(false).detail).toBe("已运行命令");
  live.apply("tool.completed", { toolCallId: "irc" });
  const summary = messageActivity({ role: "assistant", content: [{ type: "thinking", thinking: "Checking the result" }] });
  live.update(summary.title, summary.detail, summary.summary);
  expect(live.snapshot(false).detail).toBe("Checking the result");
});
