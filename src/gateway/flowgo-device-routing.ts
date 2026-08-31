import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getPairedDevice,
  projectFlowGoDevice,
  type PairedDevice,
} from "../infra/device-pairing.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import type { GatewayClient } from "./server-methods/types.js";

export type FlowGoCaller =
  | { kind: "unchanged" }
  | { kind: "error"; message: string }
  | { kind: "flowgo"; deviceId: string; device: PairedDevice };

export type FlowGoNewSessionRoute =
  | { kind: "unchanged" }
  | { kind: "error"; message: string }
  | { kind: "route"; agentId: string; sessionKey?: string; ownerDeviceId: string };

export function flowGoRequestedSessionIdMatchesOwnedEntry(params: {
  route: FlowGoNewSessionRoute;
  requestedSessionId?: string;
  ownedEntrySessionId?: string;
}): boolean {
  return (
    params.route.kind !== "route" ||
    !params.requestedSessionId ||
    params.requestedSessionId === params.ownedEntrySessionId
  );
}

const FLOWGO_SESSION_MARKER = "flowgo-device";

function clientClaimsFlowGoIdentity(client: GatewayClient): boolean {
  if (!client.connect?.client) {
    return false;
  }
  return Boolean(
    projectFlowGoDevice({
      clientId: client.connect.client.id,
      clientMode: client.connect.client.mode,
      platform: client.connect.client.platform,
      deviceFamily: client.connect.client.deviceFamily,
      modelIdentifier: client.connect.client.modelIdentifier,
      role: client.connect.role ?? "operator",
    }),
  );
}

export async function resolveFlowGoCaller(client: GatewayClient | null): Promise<FlowGoCaller> {
  const deviceId = client?.connect?.device?.id?.trim();
  if (!client || !deviceId) {
    return { kind: "unchanged" };
  }
  const device = await getPairedDevice(deviceId);
  if (!device) {
    return clientClaimsFlowGoIdentity(client)
      ? { kind: "error", message: "paired device is no longer available" }
      : { kind: "unchanged" };
  }
  if (!projectFlowGoDevice(device)) {
    return clientClaimsFlowGoIdentity(client)
      ? { kind: "error", message: "FlowGo device identity is not approved" }
      : { kind: "unchanged" };
  }
  return { kind: "flowgo", deviceId, device };
}

export async function authorizeFlowGoOwnedSession(params: {
  client: GatewayClient | null;
  ownerDeviceId?: string;
}): Promise<FlowGoCaller | { kind: "allowed"; deviceId: string }> {
  const caller = await resolveFlowGoCaller(params.client);
  if (caller.kind !== "flowgo") {
    return caller;
  }
  if (params.ownerDeviceId?.trim() === caller.deviceId) {
    return { kind: "allowed", deviceId: caller.deviceId };
  }
  return { kind: "error", message: "FlowGo session belongs to a different device" };
}

function parseFlowGoOwnedSessionKey(sessionKey: string | undefined): {
  agentId: string;
  deviceId: string;
  requestKey: string;
} | null {
  const match = sessionKey?.match(/^agent:([^:]+):flowgo-device:([^:]+):(.+)$/);
  if (!match) {
    return null;
  }
  try {
    return {
      agentId: normalizeAgentId(match[1]),
      deviceId: decodeURIComponent(match[2]),
      requestKey: match[3],
    };
  } catch {
    return null;
  }
}

function stripAgentSessionPrefix(sessionKey: string): string {
  const match = sessionKey.match(/^agent:[^:]+:(.+)$/);
  return match?.[1] ?? sessionKey;
}

export async function resolveFlowGoNewSessionRoute(params: {
  client: GatewayClient | null;
  cfg: OpenClawConfig;
  existingSessionOwnerDeviceId?: string;
  forceNewSession?: boolean;
  requestedAgentId?: string;
  requestedSessionKey?: string;
}): Promise<FlowGoNewSessionRoute> {
  const caller = await resolveFlowGoCaller(params.client);
  if (caller.kind === "unchanged") {
    return { kind: "unchanged" };
  }
  if (caller.kind === "error") {
    return caller;
  }
  const deviceId = caller.deviceId;
  const device = caller.device;

  const explicitBoundAgentId = device.boundAgentId?.trim();
  const effectiveAgentId = normalizeAgentId(
    explicitBoundAgentId || resolveDefaultAgentId(params.cfg),
  );
  if (!listAgentIds(params.cfg).includes(effectiveAgentId)) {
    return {
      kind: "error",
      message: "FlowGo device Agent is unavailable; rebind the device before starting a session",
    };
  }

  const rawSessionKey = params.requestedSessionKey?.trim();
  const ownedSession = parseFlowGoOwnedSessionKey(rawSessionKey);
  if (ownedSession) {
    if (ownedSession.deviceId !== deviceId) {
      return { kind: "error", message: "FlowGo session belongs to a different device" };
    }
    if (params.existingSessionOwnerDeviceId && !params.forceNewSession) {
      if (params.existingSessionOwnerDeviceId !== deviceId) {
        return { kind: "error", message: "FlowGo session belongs to a different device" };
      }
      const requestedAgentId = params.requestedAgentId
        ? normalizeAgentId(params.requestedAgentId)
        : undefined;
      if (requestedAgentId && requestedAgentId !== ownedSession.agentId) {
        return { kind: "error", message: "FlowGo session Agent does not match the request" };
      }
      // Canonical FlowGo session keys carry server-verifiable device ownership.
      // This is the only path that may keep using the pre-rebind Agent.
      return {
        kind: "route",
        agentId: ownedSession.agentId,
        sessionKey: rawSessionKey,
        ownerDeviceId: deviceId,
      };
    }
    if (!params.forceNewSession && ownedSession.agentId !== effectiveAgentId) {
      return {
        kind: "error",
        message: `FlowGo device is bound to Agent "${effectiveAgentId}"`,
      };
    }
  }
  const requestedAgentId = params.requestedAgentId
    ? normalizeAgentId(params.requestedAgentId)
    : undefined;
  if (
    requestedAgentId &&
    requestedAgentId !== effectiveAgentId &&
    !(params.forceNewSession && ownedSession?.deviceId === deviceId)
  ) {
    return {
      kind: "error",
      message: `FlowGo device is bound to Agent "${effectiveAgentId}"`,
    };
  }
  const sessionAgentId = parseAgentSessionKey(rawSessionKey)?.agentId;
  if (
    sessionAgentId &&
    normalizeAgentId(sessionAgentId) !== effectiveAgentId &&
    !(params.forceNewSession && ownedSession?.deviceId === deviceId)
  ) {
    return {
      kind: "error",
      message: `FlowGo device is bound to Agent "${effectiveAgentId}"`,
    };
  }
  const baseRequestKey =
    params.forceNewSession && ownedSession
      ? ownedSession.requestKey
      : rawSessionKey
        ? stripAgentSessionPrefix(rawSessionKey)
        : (params.cfg.session?.mainKey ?? "main");
  const sessionKey = toAgentStoreSessionKey({
    agentId: effectiveAgentId,
    requestKey: `${FLOWGO_SESSION_MARKER}:${encodeURIComponent(deviceId)}:${baseRequestKey}`,
    mainKey: params.cfg.session?.mainKey,
  });
  return { kind: "route", agentId: effectiveAgentId, sessionKey, ownerDeviceId: deviceId };
}
