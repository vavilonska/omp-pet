# OMP event protocol

The extension and runtime communicate through protocol version 1 over a token-authenticated loopback API. This protocol is private to OMP Pet and is not presented as a public Codex API.

Each envelope contains `protocolVersion`, `source`, `instanceId`, `sessionId`, `sequence`, `timestamp`, `type`, and an optional `payload`. `source` must be `omp`; monotonic sequence numbers suppress duplicates within one client session.

## State priority

The reducer resolves concurrent clients in this order:

1. Manual `/pet play` preview.
2. Recent failure or retry.
3. Pending approval.
4. Active OMP agent, tool, or managed background job.
5. Short review period after terminal completion.
6. Idle.

`agent_end.willContinue` is respected, so an OMP automatic continuation does not flash the completed state. Client heartbeats expire after 15 seconds. Turning event animation off clears transient activity, preventing stale work from reappearing when it is enabled again.

## Local endpoints

- `GET /v1/health`
- `GET /v1/status`
- `POST /v1/events`
- `POST /v1/control`
- `GET /v1/sprite/{petId}`

The `tool_execution_start.intent` value becomes the bubble title. A bounded, control-character-free projection of the command/path/task becomes its detail; common credential forms are redacted by the extension. Hidden model reasoning and full tool results are never sent. `background.snapshot` carries only managed job id, type, label, and start time so the frontend can render a native elapsed timer.

The runtime descriptor contains the random port and token. Session-owned runtimes store it under `runtimes/session-<uuid>.json`; the legacy unscoped path remains available for isolated smoke tests. Every descriptor is removed on clean shutdown.


## Current-state reconciliation

`client.snapshot` is an additive event supported by the updated extension/runtime.
Its payload contains `active`, `title`, `startedAt`, `tools`, `approvals`, `jobs`.
Tool/approval entries carry stable `id`, bounded `title`/`detail`, and `startedAt`.
It replaces the sending instance's prior session, not other instances. The normal
sequence guard applies. Snapshots reconcile state without triggering a new run
animation on every heartbeat. Event disabling suppresses snapshot activity too.
The extension sends snapshots on attach, bounded phase changes, and every five
seconds; a transport failure reconnects and sends current state rather than stale
queued transitions. Upgrade extension and runtime together, then restart OMP.
