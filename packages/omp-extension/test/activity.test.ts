import { describe, expect, test } from "bun:test";
import { backgroundJobPayload, redactCommand, toolActivity } from "../src/activity";

describe("OMP activity projection", () => {
  test("uses OMP intent as title and hides command contents", () => {
    const activity = toolActivity(
      "bash",
      { command: "curl -H 'Authorization: Bearer abc123' token=secret https://user:pass@example.test" },
      "等待第十五次训练开始",
    );
    expect(activity.title).toBe("等待第十五次训练开始");
    expect(activity.detail).toBe("已运行命令");
  });

  test("projects background titles and native start times", () => {
    const jobs = backgroundJobPayload({
      running: [
        { id: "job-1", type: "task", status: "running", label: "训练模型", startTime: 42 },
      ],
      recent: [],
      delivery: { pending: [], paused: false },
    } as never);
    expect(jobs).toEqual([{ id: "job-1", type: "task", title: "训练模型", startedAt: 42 }]);
  });

  test("caps projected command text", () => {
    expect(redactCommand("x".repeat(500))?.endsWith("…")).toBe(true);
  });
});
