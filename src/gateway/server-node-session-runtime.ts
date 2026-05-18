import { NodeRegistry } from "./node-registry.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { safeParseJson } from "./server-methods/nodes.helpers.js";
import { hasConnectedMobileNode } from "./server-mobile-nodes.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";

// Global key for plugins to access nodeSendToSession without bind_broadcaster warmup
const NODE_SEND_KEY = Symbol.for("openclaw.gateway.nodeSendToSession");

export type NodeSendToSessionFn = (sessionKey: string, event: string, payload: unknown) => void;

/** Returns the gateway-level nodeSendToSession singleton, available after gateway startup. */
export function getGlobalNodeSendToSession(): NodeSendToSessionFn | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[NODE_SEND_KEY] as
    | NodeSendToSessionFn
    | undefined;
}

export function createGatewayNodeSessionRuntime(params: {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}) {
  const nodeRegistry = new NodeRegistry();
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();
  const nodeSubscriptions = createNodeSubscriptionManager();
  const sessionEventSubscribers = createSessionEventSubscriberRegistry();
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
  const nodeSendEvent = (opts: { nodeId: string; event: string; payloadJSON?: string | null }) => {
    const payload = safeParseJson(opts.payloadJSON ?? null);
    nodeRegistry.sendEvent(opts.nodeId, opts.event, payload);
  };
  const nodeSendToSession = (sessionKey: string, event: string, payload: unknown) =>
    nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
  // Make nodeSendToSession accessible process-wide so plugins can use it without bind_broadcaster
  (globalThis as Record<PropertyKey, unknown>)[NODE_SEND_KEY] = nodeSendToSession;
  const nodeSendToAllSubscribed = (event: string, payload: unknown) =>
    nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    params.broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
  };
  const hasMobileNodeConnected = () => hasConnectedMobileNode(nodeRegistry);

  return {
    nodeRegistry,
    nodePresenceTimers,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe: nodeSubscriptions.subscribe,
    nodeUnsubscribe: nodeSubscriptions.unsubscribe,
    nodeUnsubscribeAll: nodeSubscriptions.unsubscribeAll,
    broadcastVoiceWakeChanged,
    hasMobileNodeConnected,
  };
}
