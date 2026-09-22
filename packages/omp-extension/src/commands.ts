import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { parsePetCommand, type PetAnimationState, type RuntimeControlRequest } from "@omp-pet/core";
import type { PetBridge, PetSummary, RuntimeStatus } from "./bridge";

const SUBCOMMANDS = [
  "show",
  "list",
  "select",
  "use",
  "next",
  "prev",
  "hide",
  "stop",
  "events",
  "debug",
  "play",
  "import",
  "status",
  "doctor",
  "help",
] as const;

const MANUAL_ANIMATIONS: PetAnimationState[] = [
  "idle",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
];

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, level);
}

function formatPets(pets: PetSummary[]): string {
  if (pets.length === 0) return "No OMP pets installed. Use /pet import <folder> when a pet is ready.";
  return pets
    .map(pet => `${pet.selected ? "●" : "○"} ${pet.id} — ${pet.displayName} (Codex v${pet.spriteVersionNumber})`)
    .join("\n");
}

function formatStatus(status: RuntimeStatus): string {
  return [
    `OMP pet: ${status.visible ? "visible" : "hidden"}`,
    `Selected: ${status.selectedPetId ?? "none"}`,
    `Animation: ${status.animation}`,
    `Events: ${status.eventsEnabled ? "on" : "off"}`,
    `Debug: ${status.debugEnabled ? "on" : "off"}`,
    `Clients: ${status.clients}, agents: ${status.activeAgents}, tools: ${status.activeTools}, approvals: ${status.pendingApprovals}, background: ${status.backgroundJobs}`,
  ].join("\n");
}

async function control(
  bridge: PetBridge,
  ctx: ExtensionCommandContext,
  request: RuntimeControlRequest,
): Promise<void> {
  const response = await bridge.control(request);
  notify(ctx, response.message);
}

export async function handlePetCommand(
  rawArgs: string,
  ctx: ExtensionCommandContext,
  bridge: PetBridge,
): Promise<void> {
  const command = parsePetCommand(rawArgs);
  bridge.rememberContext(ctx);

  try {
    switch (command.name) {
      case "show":
        await control(bridge, ctx, { action: "show" });
        bridge.startHeartbeat(ctx);
        bridge.enqueue("client.hello", ctx);
        return;
      case "list": {
        notify(ctx, formatPets(await bridge.listPets()));
        return;
      }
      case "select": {
        const pets = await bridge.listPets();
        if (pets.length === 0) {
          notify(ctx, formatPets(pets), "warning");
          return;
        }
        const labels = pets.map(pet => `${pet.id} — ${pet.displayName}`);
        const selected = await ctx.ui.select("Select OMP desktop pet", labels);
        if (!selected) return;
        const petId = selected.split(" — ", 1)[0]!;
        await control(bridge, ctx, { action: "select", petId });
        return;
      }
      case "use": {
        const petId = command.args[0];
        if (!petId) throw new Error("Usage: /pet use <pet-id>");
        await control(bridge, ctx, { action: "select", petId });
        return;
      }
      case "next":
        await control(bridge, ctx, { action: "next" });
        return;
      case "prev":
      case "previous":
        await control(bridge, ctx, { action: "previous" });
        return;
      case "hide":
        await control(bridge, ctx, { action: "hide" });
        return;
      case "stop":
        await control(bridge, ctx, { action: "stop" });
        await bridge.disconnect(ctx);
        return;
      case "events": {
        const value = command.args[0]?.toLowerCase();
        if (value !== "on" && value !== "off") throw new Error("Usage: /pet events on|off");
        await control(bridge, ctx, { action: "events", enabled: value === "on" });
        return;
      }
      case "debug": {
        const value = (command.args[0] ?? "status").toLowerCase();
        if (value === "status") {
          const response = await bridge.status();
          if (!response.data) throw new Error("Runtime returned no status data");
          notify(ctx, `OMP pet debug overlay: ${response.data.debugEnabled ? "on" : "off"}`);
          return;
        }
        if (value !== "on" && value !== "off") {
          throw new Error("Usage: /pet debug on|off|status");
        }
        await control(bridge, ctx, { action: "debug", enabled: value === "on" });
        return;
      }
      case "play": {
        const animation = command.args[0] as PetAnimationState | undefined;
        if (!animation || !MANUAL_ANIMATIONS.includes(animation)) {
          throw new Error(`Usage: /pet play <${MANUAL_ANIMATIONS.join("|")}>`);
        }
        await control(bridge, ctx, { action: "play", animation });
        return;
      }
      case "import": {
        const path = command.args[0];
        if (!path) throw new Error('Usage: /pet import "<pet-folder>"');
        await control(bridge, ctx, { action: "import", path, force: command.args.includes("--force") });
        return;
      }
      case "status": {
        const response = await bridge.status();
        if (!response.data) throw new Error("Runtime returned no status data");
        notify(ctx, formatStatus(response.data));
        return;
      }
      case "doctor":
        await control(bridge, ctx, { action: "doctor" });
        return;
      case "help":
        notify(
          ctx,
          "Commands: /pet, /pet list, /pet select, /pet use <id>, /pet next|prev, /pet hide|show|stop, /pet events on|off, /pet debug on|off|status, /pet play <state>, /pet import <folder>, /pet status, /pet doctor",
        );
        return;
      default:
        throw new Error(`Unknown /pet command: ${command.name}. Use /pet help.`);
    }
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

export function petArgumentCompletions(prefix: string, bridge: PetBridge) {
  const normalized = prefix.trimStart();
  const firstSpace = normalized.indexOf(" ");
  if (firstSpace < 0) {
    return SUBCOMMANDS.filter(item => item.startsWith(normalized)).map(item => ({
      value: item,
      label: item,
      description: item === "use" ? "Switch to an installed pet" : undefined,
    }));
  }

  const command = normalized.slice(0, firstSpace).toLowerCase();
  const valuePrefix = normalized.slice(firstSpace + 1).trimStart().toLowerCase();
  if (command === "play") {
    return MANUAL_ANIMATIONS.filter(item => item.startsWith(valuePrefix)).map(item => ({
      value: `${command} ${item}`,
      label: item,
    }));
  }
  if (command === "events" || command === "debug") {
    const values = command === "debug" ? ["on", "off", "status"] : ["on", "off"];
    return values.filter(item => item.startsWith(valuePrefix)).map(item => ({
      value: `${command} ${item}`,
      label: item,
    }));
  }
  if (command === "use") {
    return bridge.cachedPets.filter(pet => pet.id.startsWith(valuePrefix)).map(pet => ({
        value: `${command} ${pet.id}`,
        label: pet.id,
        description: pet.displayName,
      }));
  }
  return null;
}
