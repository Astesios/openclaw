import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  approveDevicePairing,
  getPairedDevice,
  listDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { loadDeviceIdentity, openTrackedWs } from "./device-authz.test-helpers.js";
import { connectReq, installGatewayTestHooks, startServerWithClient } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function seedLegacyPetIdentity(name: string) {
  const loaded = loadDeviceIdentity(name);
  const request = await requestDevicePairing({
    deviceId: loaded.identity.deviceId,
    publicKey: loaded.publicKey,
    platform: "linux",
    deviceFamily: "RaspberryPi",
    clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientMode: GATEWAY_CLIENT_MODES.UI,
    role: "operator",
    scopes: ["operator.read", "operator.write"],
  });
  const approval = await approveDevicePairing(request.request.requestId, {
    callerScopes: ["operator.read", "operator.write"],
  });
  if (!approval || approval.status !== "approved") {
    throw new Error("failed to seed legacy paired device");
  }
  const token = approval.device.tokens?.operator?.token;
  if (!token) {
    throw new Error("legacy paired device is missing its operator token");
  }
  return { ...loaded, token };
}

describe("gateway FlowGo identity repair", () => {
  test("requires approval before replacing a legacy client snapshot and hands off the rotated token", async () => {
    const started = await startServerWithClient("secret");
    const loaded = await seedLegacyPetIdentity("flowgo-identity-repair");

    const flowGoClient = {
      id: GATEWAY_CLIENT_NAMES.PET,
      version: "1.0.0",
      platform: "linux",
      mode: GATEWAY_CLIENT_MODES.UI,
      deviceFamily: "RaspberryPi",
      modelIdentifier: "FlowGo",
    } as const;
    let repairWs: WebSocket | undefined;
    let approvedReconnectWs: WebSocket | undefined;

    try {
      repairWs = await openTrackedWs(started.port);
      const repairAttempt = await connectReq(repairWs, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
        client: flowGoClient,
        scopes: ["operator.read", "operator.write"],
      });
      expect(repairAttempt.ok).toBe(false);
      expect(repairAttempt.error?.message).toBe(
        "pairing required: device identity changed and must be re-approved",
      );
      expect((repairAttempt.error?.details as { reason?: unknown } | undefined)?.reason).toBe(
        "metadata-upgrade",
      );

      const afterRejection = await getPairedDevice(loaded.identity.deviceId);
      expect(afterRejection).toMatchObject({
        clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientMode: GATEWAY_CLIENT_MODES.UI,
        platform: "linux",
        deviceFamily: "RaspberryPi",
      });
      expect(afterRejection?.modelIdentifier).toBeUndefined();
      expect(afterRejection?.tokens?.operator?.token).toBe(loaded.token);

      const pairing = await listDevicePairing();
      expect(pairing.pending).toHaveLength(1);
      expect(pairing.pending[0]).toMatchObject({
        deviceId: loaded.identity.deviceId,
        clientId: GATEWAY_CLIENT_NAMES.PET,
        clientMode: GATEWAY_CLIENT_MODES.UI,
        platform: "linux",
        deviceFamily: "RaspberryPi",
        modelIdentifier: "FlowGo",
        isRepair: true,
      });

      const approval = await approveDevicePairing(pairing.pending[0]!.requestId, {
        callerScopes: ["operator.read", "operator.write"],
      });
      if (!approval || approval.status !== "approved") {
        throw new Error("failed to approve FlowGo identity repair");
      }
      const rotatedToken = approval.device.tokens?.operator?.token;
      expect(rotatedToken).toBeTruthy();
      expect(rotatedToken).not.toBe(loaded.token);

      approvedReconnectWs = await openTrackedWs(started.port);
      const approvedReconnect = await connectReq(approvedReconnectWs, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
        client: flowGoClient,
        scopes: ["operator.read", "operator.write"],
      });
      expect(approvedReconnect.ok).toBe(true);
      expect(
        (approvedReconnect.payload as { auth?: { deviceToken?: unknown } } | undefined)?.auth
          ?.deviceToken,
      ).toBe(rotatedToken);

      const repaired = await getPairedDevice(loaded.identity.deviceId);
      expect(repaired).toMatchObject({
        clientId: GATEWAY_CLIENT_NAMES.PET,
        clientMode: GATEWAY_CLIENT_MODES.UI,
        platform: "linux",
        deviceFamily: "RaspberryPi",
        modelIdentifier: "FlowGo",
      });
      expect(repaired?.tokens?.operator?.token).toBe(rotatedToken);
    } finally {
      repairWs?.close();
      approvedReconnectWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("does not trust a direct-local client that self-declares a native app identity", async () => {
    const started = await startServerWithClient("secret");
    const loaded = await seedLegacyPetIdentity("flowgo-native-identity-bypass");
    let spoofedWs: WebSocket | undefined;

    try {
      spoofedWs = await openTrackedWs(started.port);
      const attempt = await connectReq(spoofedWs, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
        client: {
          id: GATEWAY_CLIENT_NAMES.ANDROID_APP,
          version: "1.0.0",
          platform: "linux",
          mode: GATEWAY_CLIENT_MODES.UI,
          deviceFamily: "RaspberryPi",
          modelIdentifier: "FlowGo",
        },
        scopes: ["operator.read", "operator.write"],
      });

      expect(attempt.ok).toBe(false);
      expect((attempt.error?.details as { reason?: unknown } | undefined)?.reason).toBe(
        "metadata-upgrade",
      );
      const pending = await listDevicePairing();
      expect(pending.pending).toHaveLength(1);
      expect(pending.pending[0]).toMatchObject({
        deviceId: loaded.identity.deviceId,
        clientId: GATEWAY_CLIENT_NAMES.ANDROID_APP,
        clientMode: GATEWAY_CLIENT_MODES.UI,
        modelIdentifier: "FlowGo",
        silent: false,
        isRepair: true,
      });

      const paired = await getPairedDevice(loaded.identity.deviceId);
      expect(paired).toMatchObject({
        clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientMode: GATEWAY_CLIENT_MODES.UI,
        platform: "linux",
        deviceFamily: "RaspberryPi",
      });
      expect(paired?.modelIdentifier).toBeUndefined();
      expect(paired?.tokens?.operator?.token).toBe(loaded.token);
    } finally {
      spoofedWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
