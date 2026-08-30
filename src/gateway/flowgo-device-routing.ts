import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPairedDevice, projectFlowGoDevice } from "../infra/device-pairing.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import type { GatewayClient } from "./server-methods/types.js";

export type FlowGoNewSessionRoute =
  | { kind: "unchanged" }
  | { kind: "error"; message: string }
  | { kind: "route"; agentId: string; sessionKey?: string };

export async function resolveFlowGoNewSessionRoute(params: {
  client: GatewayClient | null;
  cfg: OpenClawConfig;
  existingSession: boolean;
  requestedAgentId?: string;
  requestedSessionKey?: string;
}): Promise<FlowGoNewSessionRoute> {
  if (params.existingSession || !params.client?.isDeviceTokenAuth) {
    return { kind: "unchanged" };
  }
  const deviceId = params.client.connect.device?.id?.trim();
  if (!deviceId) {
    return { kind: "unchanged" };
  }
  const device = await getPairedDevice(deviceId);
  if (!device) {
    return { kind: "error", message: "paired device is no longer available" };
  }
  if (!projectFlowGoDevice(device)) {
    return { kind: "unchanged" };
  }

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

  const requestedAgentId = params.requestedAgentId
    ? normalizeAgentId(params.requestedAgentId)
    : undefined;
  if (requestedAgentId && requestedAgentId !== effectiveAgentId) {
    return {
      kind: "error",
      message: `FlowGo device is bound to Agent "${effectiveAgentId}"`,
    };
  }

  const rawSessionKey = params.requestedSessionKey?.trim();
  const sessionAgentId = parseAgentSessionKey(rawSessionKey)?.agentId;
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== effectiveAgentId) {
    return {
      kind: "error",
      message: `FlowGo device is bound to Agent "${effectiveAgentId}"`,
    };
  }
  const sessionKey = rawSessionKey
    ? toAgentStoreSessionKey({
        agentId: effectiveAgentId,
        requestKey: rawSessionKey,
        mainKey: params.cfg.session?.mainKey,
      })
    : undefined;
  return { kind: "route", agentId: effectiveAgentId, sessionKey };
}
