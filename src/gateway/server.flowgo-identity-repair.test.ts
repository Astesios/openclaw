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

describe("gateway FlowGo identity repair", () => {
  test("requires approval before replacing a legacy client snapshot and hands off the rotated token", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("flowgo-identity-repair");
    const legacyRequest = await requestDevicePairing({
      deviceId: loaded.identity.deviceId,
      publicKey: loaded.publicKey,
      platform: "linux",
      deviceFamily: "RaspberryPi",
      clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientMode: GATEWAY_CLIENT_MODES.UI,
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    });
    const legacyApproval = await approveDevicePairing(legacyRequest.request.requestId, {
      callerScopes: ["operator.read", "operator.write"],
    });
    if (!legacyApproval || legacyApproval.status !== "approved") {
      throw new Error("failed to seed legacy paired device");
    }
    const legacyToken = legacyApproval.device.tokens?.operator?.token;
    expect(legacyToken).toBeTruthy();

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
      expect(afterRejection?.tokens?.operator?.token).toBe(legacyToken);

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
      expect(rotatedToken).not.toBe(legacyToken);

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
});
