import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  approveDevicePairing,
  bindFlowGoDeviceAgent,
  formatDevicePairingForbiddenMessage,
  getPendingDevicePairing,
  listDevicePairing,
  projectFlowGoDevice,
  removePairedDevice,
  type RevokeDeviceTokenDenyReason,
  type RotateDeviceTokenDenyReason,
  rejectDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
  summarizeDeviceTokens,
  type DevicePairingPendingRequest,
  type PairedDevice,
} from "../../infra/device-pairing.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateDeviceAgentBindParams,
  validateDevicePairApproveParams,
  validateDevicePairListParams,
  validateDevicePairRemoveParams,
  validateDevicePairRejectParams,
  validateDeviceTokenRevokeParams,
  validateDeviceTokenRotateParams,
} from "../protocol/index.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";

const DEVICE_TOKEN_ROTATION_DENIED_MESSAGE = "device token rotation denied";
const DEVICE_TOKEN_REVOCATION_DENIED_MESSAGE = "device token revocation denied";

type DeviceSessionAuthz = {
  callerDeviceId: string | null;
  callerScopes: string[];
  isAdminCaller: boolean;
};

type DeviceManagementAuthz = DeviceSessionAuthz & {
  normalizedTargetDeviceId: string;
};

const DEVICE_PAIR_APPROVAL_DENIED_MESSAGE = "device pairing approval denied";
const DEVICE_PAIR_REJECTION_DENIED_MESSAGE = "device pairing rejection denied";

function redactPendingDevice(device: DevicePairingPendingRequest) {
  const { publicKey: _publicKey, ...rest } = device;
  return rest;
}

function redactPairedDevice(params: {
  device: PairedDevice;
  agentIds: readonly string[];
  defaultAgentId: string;
}) {
  const { publicKey: _publicKey, tokens, approvedScopes: _approvedScopes, ...rest } = params.device;
  const projection = projectFlowGoDevice(params.device);
  if (!projection) {
    return {
      ...rest,
      tokens: summarizeDeviceTokens(tokens),
    };
  }
  const rawBoundAgentId = params.device.boundAgentId;
  const boundAgentId = typeof rawBoundAgentId === "string" ? rawBoundAgentId.trim() : "";
  const candidateAgentId = boundAgentId || params.defaultAgentId;
  const agentAvailable = params.agentIds.includes(candidateAgentId);
  const rawRevision = params.device.bindingRevision;
  const bindingRevision =
    Number.isSafeInteger(rawRevision) && Number(rawRevision) >= 0 ? Number(rawRevision) : 0;
  return {
    ...rest,
    tokens: summarizeDeviceTokens(tokens),
    ...projection,
    ...(boundAgentId ? { boundAgentId } : {}),
    ...(agentAvailable ? { effectiveAgentId: candidateAgentId } : {}),
    agentAvailability: agentAvailable ? "available" : "unavailable",
    bindingRevision,
  };
}

function logDeviceTokenRotationDenied(params: {
  log: { warn: (message: string) => void };
  deviceId: string;
  role: string;
  reason: RotateDeviceTokenDenyReason | "unknown-device-or-role" | "device-ownership-mismatch";
  scope?: string | null;
}) {
  const suffix = params.scope ? ` scope=${params.scope}` : "";
  params.log.warn(
    `device token rotation denied device=${params.deviceId} role=${params.role} reason=${params.reason}${suffix}`,
  );
}

function logDeviceTokenRevocationDenied(params: {
  log: { warn: (message: string) => void };
  deviceId: string;
  role: string;
  reason: RevokeDeviceTokenDenyReason | "device-ownership-mismatch";
  scope?: string | null;
}) {
  const suffix = params.scope ? ` scope=${params.scope}` : "";
  params.log.warn(
    `device token revocation denied device=${params.deviceId} role=${params.role} reason=${params.reason}${suffix}`,
  );
}

function resolveDeviceManagementAuthz(
  client: GatewayClient | null,
  targetDeviceId: string,
): DeviceManagementAuthz {
  return {
    ...resolveDeviceSessionAuthz(client),
    normalizedTargetDeviceId: targetDeviceId.trim(),
  };
}

function resolveDeviceSessionAuthz(client: GatewayClient | null): DeviceSessionAuthz {
  const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const rawCallerDeviceId = client?.connect?.device?.id;
  const callerDeviceId =
    client?.isDeviceTokenAuth && typeof rawCallerDeviceId === "string" && rawCallerDeviceId.trim()
      ? rawCallerDeviceId.trim()
      : null;
  return {
    callerDeviceId,
    callerScopes,
    isAdminCaller: callerScopes.includes("operator.admin"),
  };
}

function deniesCrossDeviceManagement(authz: DeviceManagementAuthz): boolean {
  return Boolean(
    authz.callerDeviceId &&
    authz.callerDeviceId !== authz.normalizedTargetDeviceId &&
    !authz.isAdminCaller,
  );
}

function deniesFlowGoAgentBinding(authz: DeviceManagementAuthz): boolean {
  return !authz.isAdminCaller;
}

function shouldReturnRotatedDeviceToken(authz: DeviceManagementAuthz): boolean {
  return Boolean(authz.callerDeviceId && authz.callerDeviceId === authz.normalizedTargetDeviceId);
}

export const deviceHandlers: GatewayRequestHandlers = {
  "device.pair.list": async ({ params, respond, client, context }) => {
    if (!validateDevicePairListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.list params: ${formatValidationErrors(
            validateDevicePairListParams.errors,
          )}`,
        ),
      );
      return;
    }
    const list = await listDevicePairing();
    const cfg = context.getRuntimeConfig();
    const agentIds = listAgentIds(cfg);
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    const authz = resolveDeviceSessionAuthz(client);
    const visibleList =
      authz.callerDeviceId && !authz.isAdminCaller
        ? {
            pending: list.pending.filter(
              (request) => request.deviceId.trim() === authz.callerDeviceId,
            ),
            paired: list.paired.filter((device) => device.deviceId.trim() === authz.callerDeviceId),
          }
        : list;
    respond(
      true,
      {
        pending: visibleList.pending.map((device) => redactPendingDevice(device)),
        paired: visibleList.paired.map((device) =>
          redactPairedDevice({ device, agentIds, defaultAgentId }),
        ),
      },
      undefined,
    );
  },
  "device.pair.approve": async ({ params, respond, context, client }) => {
    if (!validateDevicePairApproveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.approve params: ${formatValidationErrors(
            validateDevicePairApproveParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { requestId } = params as { requestId: string };
    const authz = resolveDeviceSessionAuthz(client);
    if (authz.callerDeviceId && !authz.isAdminCaller) {
      const pending = await getPendingDevicePairing(requestId);
      if (!pending) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_APPROVAL_DENIED_MESSAGE),
        );
        return;
      }
      if (pending.deviceId.trim() !== authz.callerDeviceId) {
        context.logGateway.warn(
          `device pairing approval denied request=${requestId} reason=device-ownership-mismatch`,
        );
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_APPROVAL_DENIED_MESSAGE),
        );
        return;
      }
    }
    const approved = await approveDevicePairing(requestId, { callerScopes: authz.callerScopes });
    if (!approved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
      return;
    }
    if (approved.status === "forbidden") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, formatDevicePairingForbiddenMessage(approved)),
      );
      return;
    }
    context.logGateway.info(
      `device pairing approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`,
    );
    context.broadcast(
      "device.pair.resolved",
      {
        requestId,
        deviceId: approved.device.deviceId,
        decision: "approved",
        ts: Date.now(),
      },
      { dropIfSlow: true },
    );
    const cfg = context.getRuntimeConfig();
    respond(
      true,
      {
        requestId,
        device: redactPairedDevice({
          device: approved.device,
          agentIds: listAgentIds(cfg),
          defaultAgentId: normalizeAgentId(resolveDefaultAgentId(cfg)),
        }),
      },
      undefined,
    );
  },
  "device.pair.reject": async ({ params, respond, context, client }) => {
    if (!validateDevicePairRejectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.reject params: ${formatValidationErrors(
            validateDevicePairRejectParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { requestId } = params as { requestId: string };
    const authz = resolveDeviceSessionAuthz(client);
    if (authz.callerDeviceId && !authz.isAdminCaller) {
      const pending = await getPendingDevicePairing(requestId);
      if (!pending) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_REJECTION_DENIED_MESSAGE),
        );
        return;
      }
      if (pending.deviceId.trim() !== authz.callerDeviceId) {
        context.logGateway.warn(
          `device pairing rejection denied request=${requestId} reason=device-ownership-mismatch`,
        );
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_REJECTION_DENIED_MESSAGE),
        );
        return;
      }
    }
    const rejected = await rejectDevicePairing(requestId);
    if (!rejected) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
      return;
    }
    context.broadcast(
      "device.pair.resolved",
      {
        requestId,
        deviceId: rejected.deviceId,
        decision: "rejected",
        ts: Date.now(),
      },
      { dropIfSlow: true },
    );
    respond(true, rejected, undefined);
  },
  "device.pair.remove": async ({ params, respond, context, client }) => {
    if (!validateDevicePairRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.remove params: ${formatValidationErrors(
            validateDevicePairRemoveParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId } = params as { deviceId: string };
    const authz = resolveDeviceManagementAuthz(client, deviceId);
    if (deniesCrossDeviceManagement(authz)) {
      context.logGateway.warn(
        `device pairing removal denied device=${deviceId} reason=device-ownership-mismatch`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "device pairing removal denied"),
      );
      return;
    }
    const removed = await removePairedDevice(deviceId);
    if (!removed) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown deviceId"));
      return;
    }
    context.logGateway.info(`device pairing removed device=${removed.deviceId}`);
    respond(true, removed, undefined);
    queueMicrotask(() => {
      context.disconnectClientsForDevice?.(removed.deviceId);
    });
  },
  "device.agent.bind": async ({ params, respond, context, client }) => {
    if (!validateDeviceAgentBindParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.agent.bind params: ${formatValidationErrors(
            validateDeviceAgentBindParams.errors,
          )}`,
        ),
      );
      return;
    }
    const {
      deviceId,
      agentId: rawAgentId,
      expectedRevision,
    } = params as {
      deviceId: string;
      agentId: string;
      expectedRevision: number;
    };
    const authz = resolveDeviceManagementAuthz(client, deviceId);
    if (deniesFlowGoAgentBinding(authz)) {
      context.logGateway.warn(
        `device agent binding denied device=${deviceId} reason=operator-admin-required`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "device agent binding denied"),
      );
      return;
    }
    const agentId = normalizeAgentId(rawAgentId);
    if (!listAgentIds(context.getRuntimeConfig()).includes(agentId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agentId"));
      return;
    }
    const result = await bindFlowGoDeviceAgent({ deviceId, agentId, expectedRevision });
    if (!result.ok) {
      const message =
        result.reason === "unknown-device"
          ? "unknown deviceId"
          : result.reason === "not-flowgo"
            ? "device is not FlowGo"
            : `device agent binding revision conflict: current revision ${result.bindingRevision}`;
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
      return;
    }
    context.logGateway.info(
      `device agent binding updated device=${result.deviceId} oldAgent=${result.previousBoundAgentId ?? "<default>"} newAgent=${result.boundAgentId} revision=${result.bindingRevision}`,
    );
    respond(
      true,
      {
        deviceId: result.deviceId,
        boundAgentId: result.boundAgentId,
        effectiveAgentId: result.boundAgentId,
        agentAvailability: "available",
        bindingRevision: result.bindingRevision,
      },
      undefined,
    );
  },
  "device.token.rotate": async ({ params, respond, context, client }) => {
    if (!validateDeviceTokenRotateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.token.rotate params: ${formatValidationErrors(
            validateDeviceTokenRotateParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId, role, scopes } = params as {
      deviceId: string;
      role: string;
      scopes?: string[];
    };
    const authz = resolveDeviceManagementAuthz(client, deviceId);
    if (deniesCrossDeviceManagement(authz)) {
      logDeviceTokenRotationDenied({
        log: context.logGateway,
        deviceId,
        role,
        reason: "device-ownership-mismatch",
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE),
      );
      return;
    }
    const rotated = await rotateDeviceToken({
      deviceId,
      role,
      scopes,
      callerScopes: authz.callerScopes,
    });
    if (!rotated.ok) {
      logDeviceTokenRotationDenied({
        log: context.logGateway,
        deviceId,
        role,
        reason: rotated.reason,
        scope: rotated.scope,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE),
      );
      return;
    }
    const entry = rotated.entry;
    context.logGateway.info(
      `device token rotated device=${deviceId} role=${entry.role} scopes=${entry.scopes.join(",")}`,
    );
    respond(
      true,
      {
        deviceId,
        role: entry.role,
        ...(shouldReturnRotatedDeviceToken(authz) ? { token: entry.token } : {}),
        scopes: entry.scopes,
        rotatedAtMs: entry.rotatedAtMs ?? entry.createdAtMs,
      },
      undefined,
    );
    queueMicrotask(() => {
      context.disconnectClientsForDevice?.(deviceId.trim(), { role: entry.role });
    });
  },
  "device.token.revoke": async ({ params, respond, context, client }) => {
    if (!validateDeviceTokenRevokeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.token.revoke params: ${formatValidationErrors(
            validateDeviceTokenRevokeParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId, role } = params as { deviceId: string; role: string };
    const authz = resolveDeviceManagementAuthz(client, deviceId);
    if (deniesCrossDeviceManagement(authz)) {
      context.logGateway.warn(
        `device token revocation denied device=${deviceId} role=${role} reason=device-ownership-mismatch`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_REVOCATION_DENIED_MESSAGE),
      );
      return;
    }
    const revoked = await revokeDeviceToken({ deviceId, role, callerScopes: authz.callerScopes });
    if (!revoked.ok) {
      logDeviceTokenRevocationDenied({
        log: context.logGateway,
        deviceId,
        role,
        reason: revoked.reason,
        scope: revoked.scope,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_REVOCATION_DENIED_MESSAGE),
      );
      return;
    }
    const entry = revoked.entry;
    const normalizedDeviceId = deviceId.trim();
    context.logGateway.info(`device token revoked device=${normalizedDeviceId} role=${entry.role}`);
    respond(
      true,
      {
        deviceId: normalizedDeviceId,
        role: entry.role,
        revokedAtMs: entry.revokedAtMs ?? Date.now(),
      },
      undefined,
    );
    queueMicrotask(() => {
      context.disconnectClientsForDevice?.(normalizedDeviceId, { role: entry.role });
    });
  },
};
