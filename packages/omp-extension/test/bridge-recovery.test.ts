import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { PetBridge } from "../src/bridge";
import { runtimeDescriptorPath } from "../src/paths";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("transport failure reconnects and replays an authoritative offline snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-pet-bridge-test-"));
  const previous = process.env.OMP_PET_DATA_DIR;
  process.env.OMP_PET_DATA_DIR = root;
  const bridge = new PetBridge();
  const descriptor = runtimeDescriptorPath(bridge.runtimeId);
  const events: Array<{ type: string; payload?: { tools?: Array<{ id: string }> } }> = [];
  let fail = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (new URL(request.url).pathname === "/v1/events") {
      if (fail) return Response.json({ ok: false, message: "injected failure" }, { status: 503 });
      events.push(...(await request.json() as { events: typeof events }).events);
    }
    return Response.json({ ok: true, message: "ok" });
  }});
  let tick = () => {};
  const ctx = { cwd: root, sessionManager: { getSessionFile: () => "test-session" },
    isIdle: () => false, getAsyncJobSnapshot: () => null,
    setInterval(callback: () => void) { tick = callback; return 1; }, clearTimer() {},
  } as unknown as ExtensionContext;
  try {
    await mkdir(dirname(descriptor));
    await writeFile(descriptor, JSON.stringify({ protocolVersion: 1, source: "omp", pid: process.pid,
      port: server.port, token: "isolated-test-token-at-least-24-chars", startedAt: Date.now() }));
    expect(await bridge.connectIfRunning(ctx)).toBe(true);
    await until(() => events.some(e => e.type === "client.snapshot"));
    fail = true;
    bridge.enqueue("tool.started", ctx, { toolCallId: "first", title: "first" });
    await until(() => !bridge.connected);
    bridge.enqueue("tool.started", ctx, { toolCallId: "offline", title: "offline" });
    fail = false;
    for (let i = 0; i < 5; i++) tick();
    await until(() => events.some(e => e.type === "client.snapshot" && e.payload?.tools?.some(t => t.id === "offline")));
    expect(bridge.connected).toBe(true);
  } finally {
    await bridge.disconnect(ctx);
    server.stop(true);
    if (previous === undefined) delete process.env.OMP_PET_DATA_DIR;
    else process.env.OMP_PET_DATA_DIR = previous;
    await unlink(descriptor);
    await rmdir(dirname(descriptor));
    await rmdir(root);
  }
});

