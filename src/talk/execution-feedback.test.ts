import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRealtimeExecutionFeedbackSinksForTest,
  formatRealtimeExecutionAnnouncement,
  publishRealtimeExecutionFeedback,
  registerRealtimeExecutionFeedbackSink,
  type RealtimeExecutionFeedback,
} from "./execution-feedback.js";

function feedback(overrides: Partial<RealtimeExecutionFeedback> = {}): RealtimeExecutionFeedback {
  return {
    sessionKey: "agent:main:call-1",
    executionId: "execution-1",
    attemptId: "attempt-1",
    title: "生成北京路书",
    taskKind: "ROUTEBOOK_GENERATION",
    status: "SUCCEEDED",
    updatedAt: 1,
    disposition: "ANNOUNCE_WHEN_IDLE",
    idempotencyKey: "terminal-1",
    resultAvailable: true,
    ...overrides,
  };
}

afterEach(() => clearRealtimeExecutionFeedbackSinksForTest());

describe("realtime Execution feedback", () => {
  it("publishes only to the newest relay for the exact session key", () => {
    const older = vi.fn();
    const newer = vi.fn();
    const other = vi.fn();
    registerRealtimeExecutionFeedbackSink("agent:main:call-1", older);
    registerRealtimeExecutionFeedbackSink("agent:main:call-1", newer);
    registerRealtimeExecutionFeedbackSink("agent:main:call-2", other);

    publishRealtimeExecutionFeedback(feedback());

    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it("uses fixed terminal templates and truncates long titles", () => {
    expect(formatRealtimeExecutionAnnouncement(feedback())).toBe(
      "“生成北京路书”已经完成，结果已经放到卡片里了。",
    );
    expect(
      formatRealtimeExecutionAnnouncement(
        feedback({ status: "FAILED", title: "x".repeat(60), resultAvailable: false }),
      ),
    ).toBe(`“${"x".repeat(40)}”执行失败了，可以稍后到任务中心查看。`);
    expect(
      formatRealtimeExecutionAnnouncement(
        feedback({ status: "CANCELLED", title: "", resultAvailable: false }),
      ),
    ).toBe("“后台任务”已经取消。");
  });
});
