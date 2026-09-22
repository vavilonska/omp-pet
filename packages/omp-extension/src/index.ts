import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { toolActivity, messageActivity } from "./activity";
import { PetBridge } from "./bridge";
import { handlePetCommand, petArgumentCompletions } from "./commands";

export default function ompPetExtension(pi: ExtensionAPI): void {
  const bridge = new PetBridge();
  pi.setLabel("OMP Desktop Pet");

  pi.registerCommand("pet", {
    description: "Summon, switch, and manage the isolated OMP desktop pet",
    getArgumentCompletions: prefix => petArgumentCompletions(prefix, bridge),
    handler: (args, ctx) => handlePetCommand(args, ctx, bridge),
  });

  pi.on("session_start", async (_event, ctx) => {
    await bridge.connectIfRunning(ctx);
  });

  pi.on("agent_start", (_event, ctx) => bridge.enqueue("agent.started", ctx));

  pi.on("agent_end", (event, ctx) => {
    if (!event.willContinue) bridge.enqueue("agent.completed", ctx);
  });

  pi.on("tool_execution_start", (event, ctx) =>
    bridge.enqueue("tool.started", ctx, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...toolActivity(event.toolName, event.args, event.intent),
    }),
  );

  pi.on("tool_execution_end", (event, ctx) => {
    bridge.enqueue(event.isError ? "tool.failed" : "tool.completed", ctx, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
    if (!event.isError) bridge.syncActivity(ctx);
  });

  pi.on("tool_approval_requested", (event, ctx) =>
    bridge.enqueue("approval.requested", ctx, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    }),
  );

  pi.on("tool_approval_resolved", (event, ctx) =>
    bridge.enqueue("approval.resolved", ctx, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      approved: event.approved,
    }),
  );

  pi.on("session_switch", (_event, ctx) => bridge.syncActivity(ctx));
  pi.on("message_update", (event, ctx) => bridge.activity(ctx, messageActivity(event.message)));
  // Tool/IRC output is deliberately not subscribed to: progress must not repaint the bubble.
  pi.on("auto_compaction_start", (_event, ctx) => bridge.phase(ctx, "正在整理上下文"));
  pi.on("auto_compaction_end", (_event, ctx) => bridge.phase(ctx, "正在处理任务"));
  pi.on("auto_retry_end", (_event, ctx) => bridge.phase(ctx, "正在处理任务"));
  pi.on("auto_retry_start", (_event, ctx) => bridge.enqueue("retry.started", ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    await bridge.stopSession(ctx).catch(() => undefined);
  });
}
