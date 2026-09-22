import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const TITLE_LIMIT = 80;
const DETAIL_LIMIT = 220;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function oneLine(value: unknown, max = DETAIL_LIMIT): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  if (!normalized) return null;
  const characters = [...normalized];
  return characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : normalized;
}

export function redactCommand(value: unknown): string | null {
  const line = oneLine(value, DETAIL_LIMIT);
  if (!line) return null;
  return line
    .replace(/\b(authorization:\s*bearer)\s+\S+/gi, "$1 ***")
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, "$1=***")
    .replace(/(https?:\/\/[^\s:/@]+:)[^\s@]+@/gi, "$1***@");
}

export function isCommandTool(name: string): boolean {
  return ["bash", "shell", "exec", "exec_command", "powershell", "eval", "python"].includes(name.toLowerCase());
}

export function toolActivity(
  toolName: string,
  argsValue: unknown,
  intent: string | undefined,
): { title?: string; detail?: string; startedAt: number; background: boolean; command: boolean } {
  const args = record(argsValue);
  intent = intent ?? (typeof args?.i === "string" ? args.i : undefined);
  return {
    ...(oneLine(intent, TITLE_LIMIT) ? { title: oneLine(intent, TITLE_LIMIT)! } : {}),
    detail: "已运行命令",
    startedAt: Date.now(),
    background: args?.async === true || args?.background === true,
    command: true,
  };
}

export function backgroundJobPayload(
  snapshot: ReturnType<ExtensionContext["getAsyncJobSnapshot"]>,
): Array<{ id: string; type: string; title: string; startedAt: number }> {
  return (snapshot?.running ?? []).map(job => ({
    id: oneLine(job.id, 80) ?? "job",
    type: oneLine(job.type, 24) ?? "task",
    title: isCommandTool(job.type) ? "已运行命令" : redactCommand(job.label) ?? "后台任务",
    startedAt: Number.isFinite(job.startTime) ? job.startTime : Date.now(),
  }));
}

// Only display text supplied by OMP's public message/tool events; never signatures.
export function latestText(value: unknown, fromStart = false): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  const redacted = redactCommandFull(clean);
  return redacted ? (fromStart ? [...redacted].slice(0, 220) : [...redacted].slice(-220)).join("") : null;
}

function redactCommandFull(value: string): string {
  return value.replace(/\b(authorization:\s*bearer)\s+\S+/gi, "$1 ***")
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, "$1=***")
    .replace(/(https?:\/\/[^\s:/@]+:)[^\s@]+@/gi, "$1***@");
}

// Only visible thinking blocks are eligible for main-bubble text.
// Tool arguments, results, IRC envelopes and ordinary message text are not.
export function messageActivity(value: unknown): { title?: string; detail?: string; summary?: boolean } {
  const source = record(value);
  if (source?.role !== "assistant" || !Array.isArray(source.content)) return {};
  let title: string | null = null;
  let detail: string | null = null;
  let summary = false;
  for (const raw of source.content) {
    const block = record(raw);
    if (block?.type === "toolCall") {
      const args = record(block.arguments);
      title = oneLine(args?.i, TITLE_LIMIT) ?? title;
      detail = "已运行命令";
      summary = false;
    } else if (block?.type === "thinking") {
      const thinking = latestText(block.thinking, true);
      if (thinking) { detail = thinking; summary = true; }
    }
  }
  return { ...(title ? { title } : {}), ...(detail ? { detail } : {}), ...(summary ? { summary: true } : {}) };
}
