// Module-level cache for the gateway broadcast function.
//
// Plugins can only broadcast through a gateway method handler (which receives
// `context.broadcast` in its options). Tool handlers, async flows, and any
// other code paths in the plugin do NOT get a `context` object.
//
// To bridge that gap we register a no-op "warm-up" gateway method and stash
// the broadcaster on first invocation. Any other place in the plugin (tool
// handlers, lifecycle steps) can then call `broadcastLifecycle()` directly.
//
// If the warm-up method has never been called, broadcasting silently falls
// back to a no-op so the plugin never crashes when no WS clients are
// listening.

type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;

let cachedBroadcast: BroadcastFn | null = null;
let broadcastEnabled = true;

export function setBroadcaster(fn: BroadcastFn | null): void {
  cachedBroadcast = fn;
}

export function setBroadcastEnabled(enabled: boolean): void {
  broadcastEnabled = enabled;
}

export type LifecycleStage =
  | "discover.started"
  | "discover.found"
  | "discover.empty"
  | "verify.passed"
  | "verify.failed"
  | "install.started"
  | "install.complete"
  | "install.failed"
  | "update.started"
  | "update.complete";

export type LifecyclePayload = {
  stage: LifecycleStage;
  /** ClawHub slug or local skill name once known. */
  skill?: string;
  /** Human-readable display name (e.g. "Azure 发音教练"). */
  displayName?: string;
  /** Natural-language query that triggered the flow. */
  query?: string;
  /** Stage-specific extra data. */
  data?: unknown;
  /** Timestamp in ms. */
  ts: number;
};

const EVENT_PREFIX = "plugin.skill.lifecycle";

export function broadcastLifecycle(payload: Omit<LifecyclePayload, "ts">): void {
  if (!broadcastEnabled || !cachedBroadcast) {
    return;
  }
  const event = `${EVENT_PREFIX}.${payload.stage}`;
  cachedBroadcast(event, { ...payload, ts: Date.now() }, { dropIfSlow: true });
}

// ── verified-slug tracking ─────────────────────────────────────────────────
// install_skill refuses to run if the slug hasn't passed verify_skill in this
// session. That forces the agent to call the 3 tools in order (find → verify →
// install) and gives the AIPhone UI three distinct chip animations.

const verifiedSlugs = new Set<string>();

export function markSlugVerified(slug: string): void {
  verifiedSlugs.add(slug);
}

export function isSlugVerified(slug: string): boolean {
  return verifiedSlugs.has(slug);
}
