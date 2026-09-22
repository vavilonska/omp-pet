import { describe, expect, test, spyOn } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import ompPetExtension from "../src";
import { PetBridge } from "../src/bridge";

describe("OMP extension", () => {
  test("registers /pet and exposes help without starting the runtime", async () => {
    const commands = new Map<string, {
      getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    }>();
    const notifications: string[] = [];
    const api = {
      setLabel() {},
      registerCommand(name: string, command: unknown) {
        commands.set(name, command as (typeof commands extends Map<string, infer T> ? T : never));
      },
      on() {},
    } as unknown as ExtensionAPI;

    ompPetExtension(api);
    const pet = commands.get("pet");
    expect(pet).toBeDefined();
    expect(pet?.getArgumentCompletions?.("s")?.map(item => item.value)).toEqual([
      "show",
      "select",
      "stop",
      "status",
    ]);
    expect(pet?.getArgumentCompletions?.("d")?.map(item => item.value)).toEqual([
      "debug",
      "doctor",
    ]);
    expect(pet?.getArgumentCompletions?.("debug s")?.map(item => item.value)).toEqual([
      "debug status",
    ]);

    const context = {
      sessionManager: { getSessionFile: () => "test-session" },
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    } as unknown as ExtensionCommandContext;
    await pet?.handler("help", context);
    expect(notifications[0]).toContain("/pet list");
  });
});


test("command output bursts never refresh activity, including final output", () => {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const activity = spyOn(PetBridge.prototype, "activity").mockImplementation(() => {});
  const enqueue = spyOn(PetBridge.prototype, "enqueue").mockImplementation(() => {});
  const sync = spyOn(PetBridge.prototype, "syncActivity").mockImplementation(() => {});
  try {
    ompPetExtension({ setLabel() {}, registerCommand() {}, on(name: string, handler: any) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
    for (let i = 0; i < 100; i++) {
      handlers.get("tool_execution_update")?.({ toolName: "bash", partialResult: { content: [{ type: "text", text: `output ${i}` }] } }, {});
    }
    handlers.get("tool_execution_end")!({ toolName: "bash", toolCallId: "a", isError: false, result: { content: [{ type: "text", text: "final output" }] } }, {});
    for (let i = 0; i < 100; i++) {
      handlers.get("tool_execution_update")?.({ toolName: "task", partialResult: {
        content: [{ type: "text", text: "Running agent DesignSplit..." }],
        details: { progress: [{ id: "DesignSplit", lastIntent: "Child intent" }] },
      } }, {});
    }
    handlers.get("tool_execution_end")!({ toolName: "task", toolCallId: "child", isError: false,
      result: { content: [{ type: "text", text: "Child final result" }] } }, {});
    expect(handlers.has("tool_execution_update")).toBe(false);
    for (const toolName of ["irc", "hub", "grep", "custom_tool"]) {
      handlers.get("tool_execution_end")!({ toolName, toolCallId: toolName, isError: false,
        result: { content: [{ type: "text", text: "Running agent DesignSplit..." }] } }, {});
    }
    expect(activity).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(6);
    handlers.get("message_update")!({ message: { role: "assistant", content: [{ type: "thinking", thinking: "Reviewing results" }] } }, {});
    expect(activity).toHaveBeenLastCalledWith({}, { detail: "Reviewing results", summary: true });
  } finally {
    activity.mockRestore(); enqueue.mockRestore(); sync.mockRestore();
  }
});
