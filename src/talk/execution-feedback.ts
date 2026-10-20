/** Process-local side channel from standard Executions to active realtime Talk relays. */
export type RealtimeExecutionFeedbackDisposition = "STATUS_ONLY" | "ANNOUNCE_WHEN_IDLE";

export type RealtimeExecutionFeedback = {
  sessionKey: string;
  executionId: string;
  attemptId: string;
  taskKind?: string;
  title?: string;
  status: string;
  stageKey?: string;
  stageLabel?: string;
  progress?: number;
  updatedAt: number;
  disposition: RealtimeExecutionFeedbackDisposition;
  idempotencyKey: string;
  resultAvailable?: boolean;
};

export type RealtimeExecutionFeedbackSink = (feedback: RealtimeExecutionFeedback) => void;

type RegisteredSink = {
  sequence: number;
  sink: RealtimeExecutionFeedbackSink;
};

const sinksBySessionKey = new Map<string, Set<RegisteredSink>>();
let nextSinkSequence = 1;

const activeStatuses = new Set([
  "QUEUED",
  "PLANNING",
  "RUNNING",
  "AWAITING_USER",
  "PAUSED",
  "CANCELLING",
]);

export function isActiveRealtimeExecutionFeedback(feedback: RealtimeExecutionFeedback): boolean {
  return activeStatuses.has(feedback.status);
}

export function realtimeExecutionFeedbackKey(feedback: RealtimeExecutionFeedback): string {
  return `${feedback.executionId}:${feedback.attemptId}`;
}

export function formatRealtimeExecutionTitle(title: string | undefined): string {
  const normalized = title?.trim() || "后台任务";
  return [...normalized].slice(0, 40).join("");
}

export function formatRealtimeExecutionAnnouncement(feedback: RealtimeExecutionFeedback): string {
  const title = formatRealtimeExecutionTitle(feedback.title);
  if (feedback.status === "SUCCEEDED") {
    return feedback.resultAvailable
      ? `“${title}”已经完成，结果已经放到卡片里了。`
      : `“${title}”已经完成。`;
  }
  if (feedback.status === "CANCELLED") {
    return `“${title}”已经取消。`;
  }
  return `“${title}”执行失败了，可以稍后到任务中心查看。`;
}

export function formatRealtimeExecutionStatus(feedback: RealtimeExecutionFeedback): string {
  if (!isActiveRealtimeExecutionFeedback(feedback)) {
    return formatRealtimeExecutionAnnouncement(feedback);
  }
  const title = formatRealtimeExecutionTitle(feedback.title);
  const stage = feedback.stageLabel?.trim() || "处理中";
  const progress =
    typeof feedback.progress === "number"
      ? `，进度 ${Math.round(Math.max(0, Math.min(1, feedback.progress)) * 100)}%。`
      : "。";
  return `“${title}”当前状态：${stage}${progress}`;
}

/** Register one connected relay. Only the newest relay for a session receives feedback. */
export function registerRealtimeExecutionFeedbackSink(
  sessionKey: string,
  sink: RealtimeExecutionFeedbackSink,
): () => void {
  const normalized = sessionKey.trim();
  if (!normalized) {
    throw new Error("Realtime Execution feedback requires a session key");
  }
  const registered: RegisteredSink = { sequence: nextSinkSequence++, sink };
  const sinks = sinksBySessionKey.get(normalized) ?? new Set<RegisteredSink>();
  sinks.add(registered);
  sinksBySessionKey.set(normalized, sinks);
  return () => {
    const current = sinksBySessionKey.get(normalized);
    current?.delete(registered);
    if (current?.size === 0) {
      sinksBySessionKey.delete(normalized);
    }
  };
}

/** Best-effort publish to the latest connected relay for the exact session key. */
export function publishRealtimeExecutionFeedback(feedback: RealtimeExecutionFeedback): void {
  const sinks = sinksBySessionKey.get(feedback.sessionKey.trim());
  if (!sinks?.size) {
    return;
  }
  const latest = [...sinks].toSorted((a, b) => b.sequence - a.sequence)[0];
  latest?.sink(feedback);
}

export function clearRealtimeExecutionFeedbackSinksForTest(): void {
  sinksBySessionKey.clear();
}
