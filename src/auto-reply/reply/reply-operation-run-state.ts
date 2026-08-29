export type ReplyOperationAdmissionSnapshot =
  | { status: "owned" }
  | { status: "skipped"; reason: "active-run" | "aborted" };

export type ReplyOperationRunState = {
  admission?: ReplyOperationAdmissionSnapshot;
};

// Carries this invocation's admission decision through reply option spreads so
// heartbeat cleanup never infers it from whichever operation is active later.
export const REPLY_OPERATION_RUN_STATE = Symbol("openclaw.replyOperationRunState");
export const HEARTBEAT_OWNS_SYSTEM_EVENTS = Symbol("openclaw.heartbeatOwnsSystemEvents");

export type ReplyOptionsWithOperationRunState = {
  [REPLY_OPERATION_RUN_STATE]?: ReplyOperationRunState;
  [HEARTBEAT_OWNS_SYSTEM_EVENTS]?: true;
};

export function resolveReplyOperationRunState(
  options: object | undefined,
): ReplyOperationRunState | undefined {
  return (options as ReplyOptionsWithOperationRunState | undefined)?.[REPLY_OPERATION_RUN_STATE];
}

export function heartbeatOwnsSystemEvents(options: object | undefined): boolean {
  return (
    (options as ReplyOptionsWithOperationRunState | undefined)?.[HEARTBEAT_OWNS_SYSTEM_EVENTS] ===
    true
  );
}
