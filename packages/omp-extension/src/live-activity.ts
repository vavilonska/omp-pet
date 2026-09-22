// Bounded latest visible activity, retained across transport reconnects.
export class LiveActivity {
  active = false;
  completedAt: number | null = null;
  startedAt = 0;
  phase = "";
  title = "";
  detail = "";
  commandDetail: string | null = null;
  tools = new Map<string, Record<string, unknown>>();
  approvals = new Map<string, Record<string, unknown>>();

  apply(type: string, payload: Record<string, unknown> = {}, now = Date.now()): void {
    const id = String(payload.toolCallId ?? "unknown");
    if (type === "agent.started") { this.commandDetail = null; this.completedAt = null; this.title = ""; this.detail = ""; this.active = true; this.startedAt = now; this.phase = "正在处理任务"; }
    if (type === "agent.completed") { this.completedAt = now; this.active = false; this.phase = ""; this.tools.clear(); this.approvals.clear(); }
    if (type === "tool.started") {
      this.commandDetail = payload.command === true && typeof payload.detail === "string" ? payload.detail : null;
      this.update(typeof payload.title === "string" ? payload.title : undefined,
        typeof payload.detail === "string" ? payload.detail : undefined);
      this.tools.set(id, { ...payload, title: this.title || "正在执行工具", detail: this.detail || null, id, startedAt: payload.startedAt ?? now });
    }
    if (type === "tool.completed" || type === "tool.failed") this.tools.delete(id);
    if (type === "approval.requested") this.approvals.set(id, { ...payload, id, startedAt: now });
    if (type === "approval.resolved") this.approvals.delete(id);
    if (type === "retry.started") this.phase = "正在重试";
  }

  update(title?: string, detail?: string, summary = false): boolean {
    const previous = `${this.title}\n${this.detail}\n${this.commandDetail}`;
    if (summary) this.commandDetail = null;
    else if (detail === "已运行命令") this.commandDetail = detail;
    if (title) this.title = title;
    if (detail) this.detail = detail;
    for (const tool of this.tools.values()) {
      if (tool.command === true && !summary) continue;
      if (this.title) tool.title = this.title;
      if (this.detail) tool.detail = this.detail;
    }
    return previous !== `${this.title}\n${this.detail}\n${this.commandDetail}`;
  }

  snapshot(idle: boolean, now = Date.now()) {
    const active = !idle || this.phase === "正在整理上下文";
    if (!active) { this.tools.clear(); this.approvals.clear(); }
    if (active && !this.active) this.startedAt = now;
    this.active = active;
    if (active) this.completedAt = null;
    return { active, completedAt: this.completedAt, startedAt: this.startedAt || now,
      title: this.title || this.phase || "正在处理任务", detail: this.commandDetail ?? (this.detail || null),
      tools: [...this.tools.values()].slice(-64), approvals: [...this.approvals.values()].slice(-64) };
  }
}
