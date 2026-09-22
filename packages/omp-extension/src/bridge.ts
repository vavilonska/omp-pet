import { LiveActivity } from "./live-activity";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  PET_PROTOCOL_VERSION,
  createPetEvent,
  isRuntimeDescriptor,
  type PetAnimationState,
  type PetEventEnvelope,
  type PetEventType,
  type RuntimeControlRequest,
  type RuntimeDescriptor,
  type RuntimeResponse,
} from "@omp-pet/core";
import { backgroundJobPayload } from "./activity";
import { runtimeDescriptorPath, runtimeExecutableCandidates } from "./paths";

export interface PetSummary {
  id: string;
  displayName: string;
  description: string;
  spriteVersionNumber: 1 | 2;
  selected: boolean;
}

export interface RuntimeStatus {
  visible: boolean;
  selectedPetId: string | null;
  pets: PetSummary[];
  eventsEnabled: boolean;
  debugEnabled: boolean;
  animation: PetAnimationState;
  bubble: import("@omp-pet/core").PetBubble | null;
  backgroundBubbles: import("@omp-pet/core").PetBubble[];
  clients: number;
  activeAgents: number;
  activeTools: number;
  pendingApprovals: number;
  backgroundJobs: number;
}

type TimerContext = Pick<ExtensionContext, "setInterval" | "clearTimer">;

function sessionIdFor(ctx: ExtensionContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  const stableInput = sessionFile || ctx.cwd || "omp-session";
  return createHash("sha256").update(stableInput).digest("hex").slice(0, 20);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("OMP pet request timed out")), {
          once: true,
        });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export class PetBridge {
  readonly instanceId = randomUUID();
  readonly runtimeId = `session-${this.instanceId}`;
  readonly #descriptorPath = runtimeDescriptorPath(this.runtimeId);
  #sequence = 0;
  #descriptor: RuntimeDescriptor | null = null;
  #connected = false;
  #queue: PetEventEnvelope[] = [];
  #flushPromise: Promise<void> | null = null;
  #heartbeat: unknown = null;
  #heartbeatContext: TimerContext | null = null;
  #lastContext: ExtensionContext | null = null;
  #pets: PetSummary[] = [];
  #heartbeatTicks = 0;
  #backgroundFingerprint = "";
  #live = new LiveActivity();
  #sessionKey = "";
  #recovering = false;
  #desiredVisible = false;

  get connected(): boolean {
    return this.#connected;
  }

  get cachedPets(): readonly PetSummary[] {
    return this.#pets;
  }

  rememberContext(ctx: ExtensionContext): void {
    const key = sessionIdFor(ctx);
    if (this.#sessionKey && key !== this.#sessionKey) { this.#live = new LiveActivity(); this.#queue = []; this.#backgroundFingerprint = ""; }
    this.#sessionKey = key;
    this.#lastContext = ctx;
  }

  async connectIfRunning(ctx: ExtensionContext): Promise<boolean> {
    this.rememberContext(ctx);
    const descriptor = await this.#readHealthyDescriptor();
    if (!descriptor) return false;
    this.#descriptor = descriptor;
    this.#connected = true;
    this.startHeartbeat(ctx);
    this.enqueue("client.hello", ctx);
    return true;
  }

  async ensureRuntime(): Promise<RuntimeDescriptor> {
    const existing = await this.#readHealthyDescriptor();
    if (existing) {
      this.#descriptor = existing;
      this.#connected = true;
      return existing;
    }

    const candidates = runtimeExecutableCandidates();
    const executable = await this.#firstExisting(candidates);
    if (!executable) {
      throw new Error(
        `OMP pet runtime is not built. Run \`bun run runtime:build\` or set OMP_PET_RUNTIME. Checked: ${candidates.join(", ")}`,
      );
    }

    const child = spawn(executable, [], {
      detached: true,
      env: { ...process.env, OMP_PET_RUNTIME_ID: this.runtimeId, OMP_PET_OWNER_PID: String(process.pid) },
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      await Bun.sleep(80);
      const descriptor = await this.#readHealthyDescriptor();
      if (descriptor) {
        this.#descriptor = descriptor;
        this.#connected = true;
        return descriptor;
      }
    }
    throw new Error("OMP pet runtime did not become ready within 4 seconds");
  }

  async control<T = RuntimeStatus>(request: RuntimeControlRequest): Promise<RuntimeResponse<T>> {
    await this.ensureRuntime();
    if (request.action === "show") this.#desiredVisible = true;
    if (request.action === "hide" || request.action === "stop") this.#desiredVisible = false;
    return this.#request<T>("/v1/control", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async status(startIfMissing = true): Promise<RuntimeResponse<RuntimeStatus>> {
    if (startIfMissing) await this.ensureRuntime();
    else if (!(await this.#readHealthyDescriptor())) {
      throw new Error("OMP pet runtime is not running");
    }
    const response = await this.#request<RuntimeStatus>("/v1/status", { method: "GET" });
    if (response.data) this.#pets = response.data.pets;
    return response;
  }

  async listPets(startIfMissing = true): Promise<PetSummary[]> {
    const response = await this.status(startIfMissing);
    return response.data?.pets ?? this.#pets;
  }

  startHeartbeat(ctx: ExtensionContext): void {
    this.rememberContext(ctx);
    this.syncActivity(ctx);
    if (this.#heartbeat) return;
    this.#heartbeatContext = ctx;
    this.#syncBackgroundJobs(ctx);
    this.#heartbeat = ctx.setInterval(() => {
      const current = this.#lastContext;
      if (!current) return;
      this.#heartbeatTicks += 1;
      if (this.#heartbeatTicks % 5 !== 0) return;
      if (!this.#connected) { void this.#recover(current); return; }
      this.syncActivity(current);
      this.#syncBackgroundJobs(current);
    }, 1_000);
  }

  stopHeartbeat(): void {
    if (this.#heartbeat && this.#heartbeatContext) {
      this.#heartbeatContext.clearTimer(this.#heartbeat as never);
    }
    this.#heartbeat = null;
    this.#heartbeatContext = null;
    this.#heartbeatTicks = 0;
    this.#backgroundFingerprint = "";
  }

  enqueue(type: PetEventType, ctx: ExtensionContext, payload?: Record<string, unknown>): void {
    this.rememberContext(ctx);
    this.#live.apply(type, payload);
    if (!this.#connected) return;
    const event = createPetEvent({
      instanceId: this.instanceId,
      sessionId: sessionIdFor(ctx),
      sequence: ++this.#sequence,
      type,
      ...(payload ? { payload } : {}),
    });
    if (this.#queue.length >= 64) {
      this.#queue = [];
      this.syncActivity(ctx);
      return;
    }
    this.#queue.push(event);
    this.#startFlush();
  }

  #startFlush(): void {
    if (this.#flushPromise || this.#queue.length === 0) return;
    this.#flushPromise = this.#drain().finally(() => {
      this.#flushPromise = null;
      if (this.#queue.length > 0 && this.#connected) queueMicrotask(() => this.#startFlush());
    });
  }

  async disconnect(ctx?: ExtensionContext): Promise<void> {
    const current = ctx ?? this.#lastContext;
    if (current && this.#connected) {
      this.enqueue("client.goodbye", current);
      await this.#flushPromise?.catch(() => undefined);
    }
    this.stopHeartbeat();
    this.#connected = false;
    this.#descriptor = null;
    this.#queue = [];
  }

  async stopSession(ctx?: ExtensionContext): Promise<void> {
    const current = ctx ?? this.#lastContext;
    if (current && this.#connected) {
      this.enqueue("client.goodbye", current);
      await this.#flushPromise?.catch(() => undefined);
    }
    const descriptor = await this.#readHealthyDescriptor();
    if (descriptor) {
      await this.#request("/v1/control", {
        method: "POST",
        body: JSON.stringify({ action: "stop" }),
      }).catch(() => undefined);
    }
    this.stopHeartbeat();
    this.#connected = false;
    this.#descriptor = null;
    this.#queue = [];
  }

  activity(ctx: ExtensionContext, update: { title?: string; detail?: string; summary?: boolean }): void {
    this.rememberContext(ctx);
    if (this.#live.update(update.title, update.detail, update.summary)) this.syncActivity(ctx);
  }

  phase(ctx: ExtensionContext, title: string): void {
    this.rememberContext(ctx);
    if (this.#live.phase === title) return;
    this.#live.phase = title;
    this.syncActivity(ctx);
  }

  syncActivity(ctx: ExtensionContext): void {
    this.rememberContext(ctx);
    const activity = this.#live.snapshot(ctx.isIdle?.() ?? !this.#live.active);
    this.enqueue("client.snapshot", ctx, { ...activity, jobs: backgroundJobPayload(ctx.getAsyncJobSnapshot()) });
  }

  async #recover(ctx: ExtensionContext): Promise<void> {
    if (this.#recovering) return;
    this.#recovering = true;
    try {
      await this.ensureRuntime();
      if (!this.#heartbeat) return;
      this.#queue = [];
      this.#backgroundFingerprint = "";
      this.syncActivity(ctx);
      if (this.#desiredVisible) await this.#request("/v1/control", { method: "POST", body: JSON.stringify({ action: "show" }) });
    } catch { /* Retry on the next bounded heartbeat; never discard the projection. */ }
    finally { this.#recovering = false; }
  }

  #syncBackgroundJobs(ctx: ExtensionContext): void {
    const jobs = backgroundJobPayload(ctx.getAsyncJobSnapshot());
    const fingerprint = JSON.stringify(jobs);
    if (fingerprint === this.#backgroundFingerprint) return;
    this.#backgroundFingerprint = fingerprint;
    this.enqueue("background.snapshot", ctx, { jobs });
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0 && this.#connected) {
      const events = this.#queue.splice(0, this.#queue.length);
      try {
        await this.#request("/v1/events", {
          method: "POST",
          body: JSON.stringify({ protocolVersion: PET_PROTOCOL_VERSION, events }),
        });
      } catch {
        this.#lastContext?.ui?.notify("宠物事件连接中断，正在自动恢复", "warning");
        this.#connected = false;
        this.#descriptor = null;
      }
    }
  }

  async #request<T>(path: string, init: RequestInit): Promise<RuntimeResponse<T>> {
    const descriptor = this.#descriptor ?? (await this.#readHealthyDescriptor());
    if (!descriptor) throw new Error("OMP pet runtime is not running");
    this.#descriptor = descriptor;

    const response = await withTimeout(
      fetch(`http://127.0.0.1:${descriptor.port}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${descriptor.token}`,
          "content-type": "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(800),
      }),
      800,
    );
    const body = (await response.json()) as RuntimeResponse<T>;
    if (!response.ok || !body.ok) throw new Error(body.message || `OMP pet runtime returned ${response.status}`);
    this.#connected = true;
    return body;
  }

  async #readHealthyDescriptor(): Promise<RuntimeDescriptor | null> {
    try {
      const raw = JSON.parse(await readFile(this.#descriptorPath, "utf8")) as unknown;
      if (!isRuntimeDescriptor(raw)) return null;
      this.#descriptor = raw;
      const response = await withTimeout(
        fetch(`http://127.0.0.1:${raw.port}/v1/health`, {
          headers: { authorization: `Bearer ${raw.token}` },
          signal: AbortSignal.timeout(500),
        }),
        500,
      );
      if (!response.ok) return null;
      return raw;
    } catch {
      return null;
    }
  }

  async #firstExisting(paths: string[]): Promise<string | null> {
    for (const path of paths) {
      if (await pathExists(path)) return path;
    }
    return null;
  }
}
