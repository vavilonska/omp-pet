import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeDescriptor, RuntimeResponse } from "@omp-pet/core";

const testData = await mkdtemp(join(tmpdir(), "omp-pet-smoke-"));
const headless = process.argv.includes("--headless");
const executableArg = process.argv.slice(2).find(arg => arg !== "--headless");
const executable = executableArg
  ? resolve(executableArg)
  : resolve(
      "runtime",
      "src-tauri",
      "target",
      "release",
      process.platform === "win32" ? "omp-pet-runtime.exe" : "omp-pet-runtime",
    );
const child = spawn(executable, [], {
  env: { ...process.env, OMP_PET_DATA_DIR: testData },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let runtimeError = "";
child.stderr?.on("data", chunk => {
  runtimeError += String(chunk);
});

async function descriptor(): Promise<RuntimeDescriptor> {
  const path = join(testData, "runtime.json");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Runtime exited with code ${child.exitCode}${runtimeError.trim() ? `: ${runtimeError.trim()}` : ""}`,
      );
    }
    try {
      return JSON.parse(await readFile(path, "utf8")) as RuntimeDescriptor;
    } catch {
      await delay(80);
    }
  }
  throw new Error("Runtime descriptor timeout");
}

async function request<T>(
  descriptor: RuntimeDescriptor,
  path: string,
  body?: Record<string, unknown>,
): Promise<RuntimeResponse<T>> {
  const response = await fetch(`http://127.0.0.1:${descriptor.port}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${descriptor.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = (await response.json()) as RuntimeResponse<T>;
  if (!response.ok || !value.ok) throw new Error(value.message);
  return value;
}

try {
  const runtime = await descriptor();
  const health = await request(runtime, "/v1/health");
  const initial = await request<{ pets: unknown[] }>(runtime, "/v1/status");
  const shown = headless ? null : await request<{ visible: boolean }>(runtime, "/v1/control", { action: "show" });
  if (!headless && process.platform === "win32") {
    await delay(500);
    const nativeCheck = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoProfile", "-File", resolve("scripts/verify-hit-regions.ps1"), "-RuntimePid", String(child.pid),
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let nativeOutput = "";
    nativeCheck.stdout?.on("data", chunk => { nativeOutput += String(chunk); });
    nativeCheck.stderr?.on("data", chunk => { nativeOutput += String(chunk); });
    const nativeExit = await new Promise<number | null>((resolveExit, reject) => {
      nativeCheck.once("exit", resolveExit);
      nativeCheck.once("error", reject);
    });
    if (nativeExit !== 0) throw new Error(`Native hit-region check failed: ${nativeOutput.trim()}`);
    console.log(nativeOutput.trim());
  }
  const hidden = await request<{ visible: boolean }>(runtime, "/v1/control", { action: "hide" });
  const debugged = await request<{ debugEnabled: boolean }>(runtime, "/v1/control", {
    action: "debug",
    enabled: true,
  });
  const foreignSource = await fetch(`http://127.0.0.1:${runtime.port}/v1/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion: 1,
      events: [
        {
          protocolVersion: 1,
          source: "codex",
          instanceId: "foreign-test",
          sessionId: "isolated",
          sequence: 1,
          timestamp: Date.now(),
          type: "agent.started",
          payload: {},
        },
      ],
    }),
  });
  if (foreignSource.status !== 400) throw new Error("Foreign event source was not rejected");
  const accepted = await request<{ accepted: number }>(runtime, "/v1/events", {
    protocolVersion: 1,
    events: [
      {
        protocolVersion: 1,
        source: "omp",
        instanceId: "smoke-test",
        sessionId: "isolated",
        sequence: 1,
        timestamp: Date.now(),
        type: "agent.started",
        payload: {},
      },
      {
        protocolVersion: 1,
        source: "omp",
        instanceId: "smoke-test",
        sessionId: "isolated",
        sequence: 2,
        timestamp: Date.now(),
        type: "tool.started",
        payload: {
          toolCallId: "tool-1",
          toolName: "bash",
          title: "等待测试命令完成",
          detail: "> bun test",
          startedAt: Date.now() - 2_000,
        },
      },
      {
        protocolVersion: 1,
        source: "omp",
        instanceId: "smoke-test",
        sessionId: "isolated",
        sequence: 3,
        timestamp: Date.now(),
        type: "tool.completed",
        payload: { toolCallId: "tool-1", toolName: "bash" },
      },
      {
        protocolVersion: 1,
        source: "omp",
        instanceId: "smoke-test",
        sessionId: "isolated",
        sequence: 4,
        timestamp: Date.now(),
        type: "background.snapshot",
        payload: {
          jobs: [
            { id: "job-1", type: "bash", title: "后台训练", startedAt: Date.now() - 3_000 },
            { id: "job-2", type: "task", title: "后台审查", startedAt: Date.now() - 1_000 },
          ],
        },
      },
    ],
  });
  const active = await request<{
    animation: string;
    clients: number;
    debugEnabled: boolean;
    bubble: { title: string; detail: string; startedAt: number; expiresAt: number | null } | null;
    backgroundBubbles: Array<{ title: string }>;
  }>(runtime, "/v1/status");
  await delay(2_600);
  const settled = await request<{ animation: string; clients: number }>(runtime, "/v1/status");
  if (active.data?.animation !== "running" || settled.data?.animation !== "idle") {
    throw new Error(
      `One-cycle animation check failed: ${active.data?.animation ?? "missing"} -> ${settled.data?.animation ?? "missing"}`,
    );
  }
  if (
    active.data?.bubble?.title !== "等待测试命令完成" ||
    active.data.backgroundBubbles.map(item => item.title).join("|") !== "后台训练|后台审查"
  ) {
    throw new Error("Main/background bubble isolation check failed");
  }
  await request(runtime, "/v1/events", {
    protocolVersion: 1,
    events: [
      {
        protocolVersion: 1,
        source: "omp",
        instanceId: "smoke-test",
        sessionId: "isolated",
        sequence: 5,
        timestamp: Date.now(),
        type: "agent.completed",
        payload: {},
      },
    ],
  });
  const completed = await request<{
    bubble: { title: string; startedAt: number | null; expiresAt: number | null } | null;
  }>(runtime, "/v1/status");
  if (
    completed.data?.bubble?.title !== "已完成" ||
    completed.data.bubble.startedAt !== null ||
    completed.data.bubble.expiresAt !== null
  ) {
    throw new Error("Main bubble did not retain a completion notification");
  }
  await delay(3_300);
  const afterCompletion = await request<{
    animation: string;
    bubble: { title: string; expiresAt: number | null } | null;
    backgroundBubbles: unknown[];
  }>(runtime, "/v1/status");
  if (afterCompletion.data?.animation !== "idle" || afterCompletion.data.bubble?.title !== "已完成" ||
      afterCompletion.data.backgroundBubbles.length !== 2) {
    throw new Error("Completion did not retain the main bubble while preserving background work");
  }
  console.log(
    JSON.stringify(
      {
        health: health.ok,
        pets: initial.data?.pets.length,
        shown: shown?.data?.visible ?? "skipped (headless)",
        hidden: !hidden.data?.visible,
        debug: debugged.data?.debugEnabled && active.data?.debugEnabled,
        foreignSourceRejected: foreignSource.status === 400,
        eventsAccepted: accepted.data?.accepted,
        animation: active.data?.animation,
        animationAfterCycle: settled.data?.animation,
        clients: active.data?.clients,
        bubbleTitle: active.data?.bubble?.title,
        bubbleDetail: active.data?.bubble?.detail,
        bubbleSticky: active.data?.bubble?.expiresAt === null,
        backgroundBubbleTitles: active.data?.backgroundBubbles.map(item => item.title),
        completionBubblePersistent: completed.data?.bubble?.expiresAt === null,
        completionReturnsToIdle: afterCompletion.data?.animation === "idle",
        completionBubbleRetained: afterCompletion.data?.bubble?.title === "已完成",
      },
      null,
      2,
    ),
  );
  await request(runtime, "/v1/control", { action: "stop" });
  await Promise.race([
    new Promise<void>(resolveExit => child.once("exit", () => resolveExit())),
    delay(5_000).then(() => undefined),
  ]);
} finally {
  if (child.exitCode === null) child.kill();
  await rm(testData, { recursive: true, force: true });
}
