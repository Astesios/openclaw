// Plugin-sdk: session transcript injection helpers.
// Exposes appendInjectedAssistantMessageToTranscript for plugins that need to persist
// gateway-owned messages (e.g. card push markers) so they survive history reload.

import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import {
  appendInjectedAssistantMessageToTranscript,
  type GatewayInjectedTranscriptAppendResult,
} from "../gateway/server-methods/chat-transcript-inject.js";
import { loadSessionEntry } from "../gateway/session-utils.js";

export type { GatewayInjectedTranscriptAppendResult };

/**
 * Injects a gateway-injected assistant message into a session transcript by session key.
 * Resolves the transcript path internally so plugins only need the sessionKey from ctx.
 */
export function injectMessageBySessionKey(
  sessionKey: string,
  message: string,
  label?: string,
): GatewayInjectedTranscriptAppendResult {
  const { storePath, entry } = loadSessionEntry(sessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    return { ok: false, error: "session not found" };
  }
  const opts = resolveSessionFilePathOptions({ storePath });
  const transcriptPath = resolveSessionFilePath(sessionId, entry, opts);
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }
  return appendInjectedAssistantMessageToTranscript({ transcriptPath, message, label });
}
