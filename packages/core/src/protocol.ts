export const PET_PROTOCOL_VERSION = 1 as const;
export const PET_EVENT_SOURCE = "omp" as const;

export const PET_EVENT_TYPES = [
  "client.hello",
  "client.snapshot",
  "client.heartbeat",
  "client.goodbye",
  "agent.started",
  "agent.completed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.resolved",
  "retry.started",
  "background.snapshot",
] as const;

export type PetEventType = (typeof PET_EVENT_TYPES)[number];

export interface PetEventEnvelope {
  protocolVersion: typeof PET_PROTOCOL_VERSION;
  source: typeof PET_EVENT_SOURCE;
  instanceId: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  type: PetEventType;
  payload?: Record<string, unknown>;
}

export interface RuntimeDescriptor {
  protocolVersion: typeof PET_PROTOCOL_VERSION;
  source: typeof PET_EVENT_SOURCE;
  pid: number;
  port: number;
  token: string;
  startedAt: number;
}

export type PetAnimationState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review"
  | "look";

export type PetBubbleKind = "info" | "tool" | "approval" | "success" | "error" | "retry" | "completed";

export interface PetBubble {
  id: string;
  title: string;
  detail: string | null;
  kind: PetBubbleKind;
  changedAt: number;
  expiresAt: number | null;
  startedAt: number | null;
  background: boolean;
}

export interface EffectivePetState {
  animation: PetAnimationState;
  directionDegrees?: number;
  changedAt: number;
  reason: string;
  bubble: PetBubble | null;
  backgroundBubbles: PetBubble[];
}

export type RuntimeControlAction =
  | "show"
  | "hide"
  | "stop"
  | "select"
  | "next"
  | "previous"
  | "events"
  | "debug"
  | "play"
  | "import"
  | "doctor";

export interface RuntimeControlRequest {
  action: RuntimeControlAction;
  petId?: string;
  enabled?: boolean;
  animation?: PetAnimationState;
  path?: string;
  force?: boolean;
}

export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  message: string;
  data?: T;
}

export function isRuntimeDescriptor(value: unknown): value is RuntimeDescriptor {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RuntimeDescriptor>;
  return (
    item.protocolVersion === PET_PROTOCOL_VERSION &&
    item.source === PET_EVENT_SOURCE &&
    typeof item.pid === "number" &&
    Number.isInteger(item.pid) &&
    item.pid > 0 &&
    typeof item.port === "number" &&
    Number.isInteger(item.port) &&
    item.port > 0 &&
    item.port <= 65_535 &&
    typeof item.token === "string" &&
    item.token.length >= 24 &&
    typeof item.startedAt === "number"
  );
}

export function createPetEvent(
  input: Omit<PetEventEnvelope, "protocolVersion" | "source" | "timestamp"> & {
    timestamp?: number;
  },
): PetEventEnvelope {
  return {
    protocolVersion: PET_PROTOCOL_VERSION,
    source: PET_EVENT_SOURCE,
    timestamp: input.timestamp ?? Date.now(),
    instanceId: input.instanceId,
    sessionId: input.sessionId,
    sequence: input.sequence,
    type: input.type,
    ...(input.payload ? { payload: input.payload } : {}),
  };
}
