import { loadSessionEntryByKey } from "../agents/subagent-announce-delivery.js";
// Plugin-sdk: celia-canvas transcript card injection.
// Exposes injectMessageBySessionKey for the celia-canvas plugin to persist a
// gateway-injected assistant message (carrying a `[celia_card]` marker) into a
// session transcript, so pushed cards survive history reload.
//
// This wraps the upstream-maintained appendInjectedAssistantMessageToTranscript
// (which owns the exact gateway-injected envelope — provider:"openclaw",
// model:"gateway-injected" — that the celia context filter recognizes and
// strips). We only resolve the transcript path from the sessionKey here so the
// plugin never has to touch storage internals.
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import {
  appendInjectedAssistantMessageToTranscript,
  type GatewayInjectedTranscriptAppendResult,
} from "../gateway/server-methods/chat-transcript-inject.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

export type { GatewayInjectedTranscriptAppendResult };

/**
 * Injects a gateway-injected assistant message into a session transcript by
 * session key. Resolves the transcript path internally so plugins only need the
 * sessionKey from ctx.
 */
export async function injectMessageBySessionKey(
  sessionKey: string,
  message: string,
  label?: string,
  options?: { idempotencyKey?: string },
): Promise<GatewayInjectedTranscriptAppendResult> {
  const entry = loadSessionEntryByKey(sessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    return { ok: false, error: "session not found" };
  }
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const opts = resolveSessionFilePathOptions({ agentId });
  const transcriptPath = resolveSessionFilePath(sessionId, entry, opts);
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }
  return await appendInjectedAssistantMessageToTranscript({
    transcriptPath,
    sessionKey,
    message,
    ...(label !== undefined ? { label } : {}),
    ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  });
}
