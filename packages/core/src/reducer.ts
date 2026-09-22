import { STANDARD_ANIMATIONS } from "./codex-assets";
import type {
  EffectivePetState,
  PetAnimationState,
  PetBubble,
  PetBubbleKind,
  PetEventEnvelope,
} from "./protocol";

interface ClientState {
  lastSeen: number;
  activeAgent: boolean;
  completedAt?: number;
  dismissedCompletedAt?: number;
  intent?: ActiveOperation;
  activeTools: Map<string, ActiveOperation>;
  backgroundJobs: Map<string, ActiveOperation>;
  pendingApprovals: Set<string>;
}

interface ActiveOperation {
  title: string;
  detail: string | null;
  startedAt: number;
  background: boolean;
}

interface BubbleSpec extends ActiveOperation {
  ownerKey?: string;
  kind: PetBubbleKind;
  durationMs: number | null;
}

export interface PetReducerOptions {
  clientTimeoutMs?: number;
  failedDurationMs?: number;
  reviewDurationMs?: number;
  runningCycleMs?: number;
  waitingCycleMs?: number;
}

export class PetEventReducer {
  readonly #clients = new Map<string, ClientState>();
  readonly #clientTimeoutMs: number;
  readonly #failedDurationMs: number;
  readonly #reviewDurationMs: number;
  readonly #runningCycleMs: number;
  readonly #waitingCycleMs: number;
  #failedUntil = 0;
  #reviewUntil = 0;
  #runningUntil = 0;
  #waitingUntil = 0;
  #manual: { animation: PetAnimationState; until: number } | null = null;
  #bubble: PetBubble | null = null;
  #bubbleOwnerKey: string | null = null;
  #eventsEnabled = true;
  #lastState: EffectivePetState = {
    animation: "idle",
    changedAt: 0,
    reason: "initial",
    bubble: null,
    backgroundBubbles: [],
  };

  constructor(options: PetReducerOptions = {}) {
    this.#clientTimeoutMs = options.clientTimeoutMs ?? 15_000;
    this.#failedDurationMs = options.failedDurationMs ?? 3_660;
    this.#reviewDurationMs = options.reviewDurationMs ?? 3_090;
    this.#runningCycleMs = options.runningCycleMs ?? 2_460;
    this.#waitingCycleMs = options.waitingCycleMs ?? 3_030;
  }

  dismissCompletedBubble(bubbleId: string, now: number): boolean {
    const current = this.state(now).bubble;
    if (current?.kind !== "completed" || current.id !== bubbleId) return false;
    const client = this.#bubbleOwnerKey ? this.#clients.get(this.#bubbleOwnerKey) : undefined;
    if (!client) return false;
    // Keep the acknowledgement separate: idle snapshots resend completedAt.
    client.dismissedCompletedAt = client.completedAt;
    this.#bubble = null;
    this.#bubbleOwnerKey = null;
    return true;
  }

  setEventsEnabled(enabled: boolean): void {
    this.#eventsEnabled = enabled;
    if (!enabled) {
      this.#failedUntil = 0;
      this.#reviewUntil = 0;
      this.#runningUntil = 0;
      this.#waitingUntil = 0;
      this.#bubble = null;
      for (const client of this.#clients.values()) {
        client.activeAgent = false;
        client.completedAt = undefined;
        client.activeTools.clear();
        client.backgroundJobs.clear();
        client.pendingApprovals.clear();
      }
    }
  }

  setManual(animation: PetAnimationState, now: number, durationMs?: number): void {
    const oneCycleMs =
      animation === "running"
        ? this.#runningCycleMs
        : animation === "waiting"
          ? this.#waitingCycleMs
          : durationMs ?? (STANDARD_ANIMATIONS.find(item => item.state === animation)?.frameDurationsMs.reduce((a, b) => a + b, 0) ?? 2_200) * (animation === "idle" ? 1 : 3);
    this.#manual = { animation, until: now + Math.max(0, oneCycleMs) };
  }

  apply(event: PetEventEnvelope): void {
    if (!this.#eventsEnabled && !event.type.startsWith("client.")) return;
    const key = `${event.instanceId}:${event.sessionId}`;
    if (event.type === "client.snapshot") {
      for (const owner of this.#clients.keys()) if (owner.startsWith(`${event.instanceId}:`) && owner !== key) this.#clients.delete(owner);
    }
    const client = this.#clients.get(key) ?? {
      lastSeen: event.timestamp,
      activeAgent: false,
      activeTools: new Map<string, ActiveOperation>(),
      backgroundJobs: new Map<string, ActiveOperation>(),
      pendingApprovals: new Set<string>(),
    };
    client.lastSeen = event.timestamp;

    const toolCallId =
      typeof event.payload?.toolCallId === "string" ? event.payload.toolCallId : "unknown";
    const toolAction = describeToolAction(event.payload?.toolName);
    const toolOperation: ActiveOperation = {
      title: safeLine(event.payload?.title, 80) ?? toolAction,
      detail: safeLine(event.payload?.detail, 220),
      startedAt: safeTimestamp(event.payload?.startedAt, event.timestamp),
      background: event.payload?.background === true,
    };
    let bubble: BubbleSpec | null = null;

    switch (event.type) {
      case "client.snapshot": {
        if (!this.#eventsEnabled) break;
        client.activeAgent = event.payload?.active === true;
        client.completedAt = !client.activeAgent && typeof event.payload?.completedAt === "number" && event.payload.completedAt > 0
          ? event.payload.completedAt : undefined;
        client.intent = toolOperation;
        client.activeTools = parseOperations(event.payload?.tools, event.timestamp);
        client.pendingApprovals = new Set(parseOperations(event.payload?.approvals, event.timestamp).keys());
        client.backgroundJobs = parseBackgroundJobs(event.payload?.jobs, event.timestamp);
        if (this.#bubbleOwnerKey === key && this.#bubble?.expiresAt === null) this.#bubble = null;
        break;
      }
      case "client.goodbye":
        this.#clients.delete(key);
        return;
      case "agent.started":
        client.completedAt = undefined;
        client.activeAgent = true;
        client.intent = { title: "OMP 正在处理", detail: "正在处理任务", startedAt: event.timestamp, background: false };
        this.#pulseRunning(event.timestamp);
        this.#reviewUntil = 0;
        if (!this.#bubble || this.#bubbleOwnerKey === key) bubble = {
          title: "OMP 正在处理",
          detail: "准备任务…",
          startedAt: event.timestamp,
          background: false,
          kind: "info",
          durationMs: null,
        };
        break;
      case "agent.completed":
        client.completedAt = event.timestamp;
        client.activeAgent = false;
        client.activeTools.clear();
        client.pendingApprovals.clear();
        this.#runningUntil = 0;
        this.#reviewUntil = Math.max(this.#reviewUntil, event.timestamp + this.#reviewDurationMs);
        if (this.#bubbleOwnerKey === key && this.#bubble?.kind !== "error") this.#bubble = null;
        break;
      case "tool.started":
        client.activeTools.set(toolCallId, toolOperation);
        this.#pulseRunning(event.timestamp);
        bubble = { ...toolOperation, kind: "tool", durationMs: null };
        break;
      case "tool.completed":
        client.activeTools.delete(toolCallId);
        bubble = this.#latestActiveBubble();
        break;
      case "tool.failed":
        client.activeTools.delete(toolCallId);
        this.#failedUntil = Math.max(this.#failedUntil, event.timestamp + this.#failedDurationMs);
        bubble = {
          ...completedBubble("步骤失败", event.timestamp, 3_000),
          detail: toolOperation.title,
          kind: "error",
        };
        break;
      case "approval.requested":
        client.pendingApprovals.add(toolCallId);
        this.#waitingUntil = Math.max(
          this.#waitingUntil,
          event.timestamp + this.#waitingCycleMs,
        );
        bubble = {
          ...toolOperation,
          title: "需要批准",
          detail: toolOperation.title,
          kind: "approval",
          durationMs: null,
        };
        break;
      case "approval.resolved":
        client.pendingApprovals.delete(toolCallId);
        bubble = {
          title: event.payload?.approved === true ? "已批准，继续执行" : "操作未获批准",
          detail: null,
          startedAt: event.timestamp,
          background: false,
          kind: event.payload?.approved === true ? "success" : "error",
          durationMs: 2_400,
        };
        break;
      case "retry.started":
        this.#failedUntil = Math.max(this.#failedUntil, event.timestamp + this.#failedDurationMs);
        bubble = {
          title: "正在重试",
          detail: safeLine(event.payload?.detail, 220),
          startedAt: event.timestamp,
          background: false,
          kind: "retry",
          durationMs: null,
        };
        break;
      case "background.snapshot": {
        const previousJobIds = new Set(client.backgroundJobs.keys());
        client.backgroundJobs = parseBackgroundJobs(event.payload?.jobs, event.timestamp);
        if ([...client.backgroundJobs.keys()].some(id => !previousJobIds.has(id))) {
          this.#pulseRunning(event.timestamp);
        }
        // Background jobs render in their own stack and never replace the main-agent bubble.
        break;
      }
      default:
        break;
    }
    this.#clients.set(key, client);
    if (event.type === "agent.completed" &&
        ![...this.#clients.values()].some(item => item.pendingApprovals.size > 0)) {
      this.#waitingUntil = 0;
    }
    if (event.type === "approval.resolved") {
      const pendingClient = [...this.#clients.entries()].find(
        ([, item]) => item.pendingApprovals.size > 0,
      );
      if (pendingClient) {
        bubble = {
          ownerKey: pendingClient[0],
          title: "仍有操作等待批准",
          detail: null,
          startedAt: event.timestamp,
          background: false,
          kind: "approval",
          durationMs: null,
        };
      }
    }
    if (bubble) this.#showBubble(event, bubble);
  }

  sweep(now: number): void {
    for (const [key, client] of this.#clients) {
      if (now - client.lastSeen > this.#clientTimeoutMs) this.#clients.delete(key);
    }
    if (this.#manual && this.#manual.until <= now) this.#manual = null;
    if (this.#bubble && this.#bubble.expiresAt !== null && this.#bubble.expiresAt <= now) {
      this.#bubble = null;
    }
  }

  state(now: number): EffectivePetState {
    this.sweep(now);
    if (this.#bubbleOwnerKey && !this.#clients.has(this.#bubbleOwnerKey)) { this.#bubble = null; this.#bubbleOwnerKey = null; }
    if (this.#bubble?.kind === "completed" && this.#activeFallback()) this.#bubble = null;
    if (this.#eventsEnabled && !this.#bubble) {
      const spec = this.#activeFallback();
      if (spec) {
        this.#bubbleOwnerKey = spec.ownerKey!;
        this.#bubble = { id: `${spec.ownerKey}:active:${spec.kind}:${spec.startedAt}`, title: spec.title,
          detail: spec.detail, kind: spec.kind, changedAt: now, expiresAt: null, startedAt: spec.startedAt, background: false };
      }
      if (!this.#bubble) {
        const completed = [...this.#clients.entries()].filter(([, c]) => c.completedAt !== undefined && c.completedAt !== c.dismissedCompletedAt)
          .sort((a, b) => b[1].completedAt! - a[1].completedAt!)[0];
        if (completed) {
          const [owner, client] = completed;
          this.#bubbleOwnerKey = owner;
          this.#bubble = { id: `${owner}:completed:${client.completedAt}`, title: "已完成",
            detail: "点击返回 OMP 并关闭提示", kind: "completed", changedAt: client.completedAt!,
            expiresAt: null, startedAt: null, background: false };
        }
      }
    }
    let animation: PetAnimationState = "idle";
    let reason = "idle";

    if (this.#manual && this.#manual.until > now) {
      animation = this.#manual.animation;
      reason = "manual";
    } else if (this.#eventsEnabled && this.#failedUntil > now) {
      animation = "failed";
      reason = "recent failure";
    } else if (this.#eventsEnabled && this.#waitingUntil > now) {
      animation = "waiting";
      reason = "approval pending";
    } else if (this.#eventsEnabled && this.#runningUntil > now) {
      animation = "running";
      reason = "OMP work active";
    } else if (this.#eventsEnabled && this.#reviewUntil > now) {
      animation = "review";
      reason = "OMP work completed";
    }

    const bubble = this.#bubble ? { ...this.#bubble } : null;
    const backgroundBubbles = this.#backgroundBubbles();
    if (
      animation !== this.#lastState.animation ||
      reason !== this.#lastState.reason ||
      JSON.stringify(bubble) !== JSON.stringify(this.#lastState.bubble) ||
      JSON.stringify(backgroundBubbles) !== JSON.stringify(this.#lastState.backgroundBubbles)
    ) {
      this.#lastState = { animation, changedAt: now, reason, bubble, backgroundBubbles };
    }
    return {
      ...this.#lastState,
      bubble: this.#lastState.bubble ? { ...this.#lastState.bubble } : null,
      backgroundBubbles: this.#lastState.backgroundBubbles.map(item => ({ ...item })),
    };
  }

  #showBubble(event: PetEventEnvelope, bubble: BubbleSpec): void {
    this.#bubbleOwnerKey = bubble.ownerKey ?? `${event.instanceId}:${event.sessionId}`;
    this.#bubble = {
      id: `${event.instanceId}:${event.sessionId}:${event.sequence}`,
      title: bubble.title,
      detail: bubble.detail,
      kind: bubble.kind,
      changedAt: event.timestamp,
      expiresAt: bubble.durationMs === null ? null : event.timestamp + bubble.durationMs,
      startedAt: bubble.startedAt,
      background: bubble.background,
    };
  }

  #pulseRunning(now: number): void {
    this.#runningUntil = Math.max(this.#runningUntil, now + this.#runningCycleMs);
  }

  #latestActiveBubble(): BubbleSpec | null {
    const operations = [...this.#clients.entries()].flatMap(([ownerKey, client]) =>
      [...client.activeTools.values()].map(operation => ({ ...operation, ownerKey })),
    );
    const latest = operations.sort((left, right) => right.startedAt - left.startedAt)[0];
    return latest ? { ...latest, kind: "tool", durationMs: null } : null;
  }

  #activeFallback(): BubbleSpec | null {
    const pending = [...this.#clients.entries()].find(([, c]) => c.pendingApprovals.size > 0);
    if (pending) return { ownerKey: pending[0], title: "需要批准", detail: null,
      startedAt: pending[1].intent?.startedAt ?? pending[1].lastSeen, background: false, kind: "approval", durationMs: null };
    const tool = this.#latestActiveBubble();
    if (tool) return tool;
    const active = [...this.#clients.entries()].filter(([, c]) => c.activeAgent).sort((a,b) => b[1].lastSeen-a[1].lastSeen)[0];
    return active ? { ...(active[1].intent ?? { title: "OMP 正在处理", detail: null, startedAt: active[1].lastSeen, background: false }), ownerKey: active[0], kind: "info", durationMs: null } : null;
  }

  #backgroundBubbles(): PetBubble[] {
    return [...this.#clients.entries()]
      .flatMap(([clientKey, client]) =>
        [...client.backgroundJobs.entries()].map(([jobId, operation]) => ({
          id: `${clientKey}:background:${jobId}`,
          title: operation.title,
          detail: operation.detail,
          kind: "tool" as const,
          changedAt: operation.startedAt,
          expiresAt: null,
          startedAt: operation.startedAt,
          background: true,
        })),
      )
      .sort((left, right) => left.startedAt! - right.startedAt! || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  snapshot(now: number): {
    state: EffectivePetState;
    eventsEnabled: boolean;
    clients: number;
    activeAgents: number;
    activeTools: number;
    pendingApprovals: number;
    backgroundJobs: number;
  } {
    const clients = [...this.#clients.values()];
    return {
      state: this.state(now),
      eventsEnabled: this.#eventsEnabled,
      clients: clients.length,
      activeAgents: clients.filter(client => client.activeAgent).length,
      activeTools: clients.reduce((sum, client) => sum + client.activeTools.size, 0),
      pendingApprovals: clients.reduce((sum, client) => sum + client.pendingApprovals.size, 0),
      backgroundJobs: clients.reduce((sum, client) => sum + client.backgroundJobs.size, 0),
    };
  }
}

function completedBubble(title: string, timestamp: number, durationMs: number): BubbleSpec {
  return {
    title,
    detail: null,
    startedAt: timestamp,
    background: false,
    kind: "success",
    durationMs,
  };
}

function safeLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  if (!normalized) return null;
  const characters = [...normalized];
  return characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : normalized;
}

function safeTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseBackgroundJobs(value: unknown, fallback: number): Map<string, ActiveOperation> {
  const jobs = new Map<string, ActiveOperation>();
  if (!Array.isArray(value)) return jobs;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const id = safeLine(candidate.id, 80);
    if (!id) continue;
    const type = safeLine(candidate.type, 24) ?? "task";
    jobs.set(id, {
      title: safeLine(candidate.title, 80) ?? "后台任务",
      detail: `后台 ${type} 任务`,
      startedAt: safeTimestamp(candidate.startedAt, fallback),
      background: true,
    });
  }
  return jobs;
}

function describeToolAction(value: unknown): string {
  const original = typeof value === "string" ? value.trim() : "";
  const normalized = original.toLowerCase();
  const known: Record<string, string> = {
    read: "正在读取文件",
    bash: "正在运行命令",
    edit: "正在编辑文件",
    write: "正在写入文件",
    grep: "正在搜索工作区",
    glob: "正在查找文件",
    lsp: "正在检查代码",
    python: "正在运行 Python",
    notebook: "正在更新 Notebook",
    inspect_image: "正在查看图片",
    browser: "正在使用浏览器",
    computer: "正在操作桌面",
    task: "正在运行子任务",
    todo: "正在更新任务列表",
    web_search: "正在搜索网页",
    ask: "正在等待回答",
  };
  if (known[normalized]) return known[normalized];
  const safeName = [...original.replace(/\s+/g, " ")].slice(0, 28).join("");
  return safeName ? `正在使用 ${safeName}` : "正在使用工具";
}

function parseOperations(value: unknown, now: number): Map<string, ActiveOperation> {
  const result = new Map<string, ActiveOperation>();
  if (Array.isArray(value)) for (const item of value.slice(0, 64)) {
    if (!item || typeof item !== "object") continue;
    const id = safeLine(item.id, 160);
    if (id) result.set(id, { title: safeLine(item.title, 80) ?? "正在执行工具", detail: safeLine(item.detail, 220), startedAt: safeTimestamp(item.startedAt, now), background: false });
  }
  return result;
}
