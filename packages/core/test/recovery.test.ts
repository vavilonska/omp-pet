import { expect, test } from "bun:test";
import { PetEventReducer, createPetEvent } from "../src";

function send(r: PetEventReducer, type: Parameters<typeof createPetEvent>[0]["type"], time: number, payload = {}, sessionId = "s") {
  r.apply(createPetEvent({ instanceId: "i", sessionId, sequence: time, timestamp: time, type, payload }));
}

test("completion survives heartbeat snapshots and runtime recreation, then clears on session switch", () => {
  const r = new PetEventReducer();
  send(r, "agent.started", 10);
  send(r, "agent.completed", 20);
  const done = r.state(21).bubble;
  expect(done).toMatchObject({ title: "已完成", expiresAt: null, startedAt: null });
  send(r, "client.snapshot", 60_000, { active: false, completedAt: 20 });
  expect(r.state(60_001).bubble).toEqual(done);
  const restarted = new PetEventReducer();
  send(restarted, "client.snapshot", 60_000, { active: false, completedAt: 20 });
  expect(restarted.state(60_001).bubble).toEqual(done);
  send(restarted, "client.snapshot", 60_010, { active: false }, "new-session");
  expect(restarted.state(60_011).bubble).toBeNull();
});
test("expired failure restores live agent intent", () => {
  const r = new PetEventReducer();
  send(r, "agent.started", 10);
  send(r, "tool.failed", 20, { toolCallId: "a" });
  expect(r.state(3020).bubble).toMatchObject({ kind: "info", expiresAt: null, startedAt: 10 });
});

test("dismissed completion stays hidden through snapshots and preserves background work", () => {
  const r = new PetEventReducer();
  send(r, "agent.started", 10);
  send(r, "agent.completed", 20);
  const done = r.state(21).bubble!;
  expect(r.dismissCompletedBubble(done.id, 22)).toBe(true);
  expect(r.state(23).bubble).toBeNull();
  send(r, "client.snapshot", 30, { active: false, completedAt: 20,
    jobs: [{ id: "job", title: "background work", startedAt: 10 }] });
  expect(r.state(31).bubble).toBeNull();
  expect(r.state(31).backgroundBubbles).toHaveLength(1);
  expect(r.dismissCompletedBubble(done.id, 32)).toBe(false);
  send(r, "agent.started", 40);
  expect(r.state(41).bubble?.kind).toBe("info");
  send(r, "agent.completed", 50);
  const next = r.state(51).bubble!;
  expect(next.kind).toBe("completed");
  expect(next.id).not.toBe(done.id);
  expect(r.dismissCompletedBubble(done.id, 52)).toBe(false);
  expect(r.state(53).bubble).toEqual(next);
  expect(r.dismissCompletedBubble(next.id, 54)).toBe(true);
});

test("completion dismissal rejects active work and leaves another client's reminder intact", () => {
  const r = new PetEventReducer();
  send(r, "agent.started", 10);
  const active = r.state(11).bubble!;
  expect(r.dismissCompletedBubble(active.id, 12)).toBe(false);
  expect(r.state(13).bubble).toEqual(active);
  send(r, "agent.completed", 20);
  const first = r.state(21).bubble!;
  r.apply(createPetEvent({ instanceId: "other", sessionId: "s", sequence: 1,
    timestamp: 30, type: "client.snapshot", payload: { active: false, completedAt: 30 } }));
  expect(r.dismissCompletedBubble(first.id, 31)).toBe(true);
  expect(r.state(32).bubble?.id).toBe("other:s:completed:30");
});
test("approval feedback expiry restores a parallel tool", () => {
  const r = new PetEventReducer();
  send(r, "agent.started", 10);
  send(r, "tool.started", 20, { toolCallId: "a", title: "active tool" });
  send(r, "approval.resolved", 30, { toolCallId: "b", approved: true });
  expect(r.state(2430).bubble).toMatchObject({ kind: "tool", title: "active tool", startedAt: 20 });
});
test("late snapshots recover work and session switches remove old activity", () => {
  const r = new PetEventReducer();
  send(r, "client.snapshot", 10, { active: true, title: "generating", startedAt: 1, tools: [], approvals: [], jobs: [] });
  expect(r.state(10).bubble?.title).toBe("generating");
  send(r, "client.snapshot", 20, { active: false, tools: [], approvals: [], jobs: [] }, "new");
  expect(r.state(20).bubble).toBeNull();
  expect(r.snapshot(20).clients).toBe(1);
});
test("snapshot preserves finite feedback, then restores current phase", () => {
  const r = new PetEventReducer();
  send(r, "tool.failed", 10);
  send(r, "client.snapshot", 20, { active: true, title: "retrying", startedAt: 1 });
  expect(r.state(21).bubble?.kind).toBe("error");
  expect(r.state(3010).bubble?.title).toBe("retrying");
  r.setEventsEnabled(false);
  send(r, "client.snapshot", 3020, { active: true });
  expect(r.state(3020).bubble).toBeNull();
});


test("equal-time background jobs have a stable ID tie-break across snapshots", () => {
  const r = new PetEventReducer();
  const jobs = ["b", "a", "c"].map(id => ({ id, title: id, startedAt: 1 }));
  send(r, "background.snapshot", 10, { jobs });
  expect(r.state(11).backgroundBubbles.map(b => b.title)).toEqual(["a", "b", "c"]);
  send(r, "background.snapshot", 20, { jobs: [...jobs].reverse() });
  expect(r.state(21).backgroundBubbles.map(b => b.title)).toEqual(["a", "b", "c"]);
});
