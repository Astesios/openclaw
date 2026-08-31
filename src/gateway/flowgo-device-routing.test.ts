import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PairedDevice } from "../infra/device-pairing.js";
import {
  authorizeFlowGoOwnedSession,
  flowGoRequestedSessionIdMatchesOwnedEntry,
  resolveFlowGoNewSessionRoute,
} from "./flowgo-device-routing.js";
import type { GatewayClient } from "./server-methods/types.js";

const getPairedDeviceMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/device-pairing.js")>(
    "../infra/device-pairing.js",
  );
  return { ...actual, getPairedDevice: getPairedDeviceMock };
});

const cfg = {
  agents: { list: [{ id: "main" }, { id: "pet-agent" }] },
};

function createClient(isDeviceTokenAuth = true): GatewayClient {
  return {
    isDeviceTokenAuth,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-pet",
        version: "1.0.0",
        platform: "linux",
        deviceFamily: "RaspberryPi",
        modelIdentifier: "FlowGo",
        mode: "ui",
      },
      device: {
        id: "flowgo-1",
        publicKey: "public-key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
    },
  };
}

function flowGoDevice(patch: Partial<PairedDevice> = {}): PairedDevice {
  return {
    deviceId: "flowgo-1",
    publicKey: "public-key",
    clientId: "openclaw-pet",
    clientMode: "ui",
    platform: "linux",
    deviceFamily: "RaspberryPi",
    modelIdentifier: "FlowGo",
    role: "operator",
    createdAtMs: 1,
    approvedAtMs: 2,
    ...patch,
  };
}

describe("FlowGo new-session routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects the persistent binding into an unscoped new session key", async () => {
    getPairedDeviceMock.mockResolvedValue(flowGoDevice({ boundAgentId: "pet-agent" }));

    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
        requestedSessionKey: "main",
      }),
    ).resolves.toEqual({
      kind: "route",
      agentId: "pet-agent",
      sessionKey: "agent:pet-agent:flowgo-device:flowgo-1:main",
      ownerDeviceId: "flowgo-1",
    });
  });

  it("uses the default Agent for a compatible historical unbound FlowGo record", async () => {
    getPairedDeviceMock.mockResolvedValue(flowGoDevice());

    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
      }),
    ).resolves.toEqual({
      kind: "route",
      agentId: "main",
      sessionKey: "agent:main:flowgo-device:flowgo-1:main",
      ownerDeviceId: "flowgo-1",
    });
  });

  it("rejects a client-reported Agent or session key that differs from the binding", async () => {
    getPairedDeviceMock.mockResolvedValue(flowGoDevice({ boundAgentId: "pet-agent" }));

    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
        requestedAgentId: "main",
      }),
    ).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("pet-agent") });
    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
        requestedSessionKey: "agent:main:main",
      }),
    ).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("pet-agent") });
  });

  it("fails closed when the bound Agent or paired device is unavailable", async () => {
    getPairedDeviceMock.mockResolvedValueOnce(flowGoDevice({ boundAgentId: "deleted-agent" }));
    await expect(
      resolveFlowGoNewSessionRoute({ client: createClient(), cfg }),
    ).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("rebind") });

    getPairedDeviceMock.mockResolvedValueOnce(null);
    await expect(resolveFlowGoNewSessionRoute({ client: createClient(), cfg })).resolves.toEqual({
      kind: "error",
      message: "paired device is no longer available",
    });
  });

  it("routes shared-auth FlowGo and does not trust an unrelated existing session", async () => {
    getPairedDeviceMock.mockResolvedValue(flowGoDevice({ boundAgentId: "pet-agent" }));
    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
        requestedAgentId: "main",
        requestedSessionKey: "agent:main:existing",
      }),
    ).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("pet-agent") });
    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(false),
        cfg,
        requestedAgentId: "pet-agent",
        requestedSessionKey: "main",
      }),
    ).resolves.toEqual({
      kind: "route",
      agentId: "pet-agent",
      sessionKey: "agent:pet-agent:flowgo-device:flowgo-1:main",
      ownerDeviceId: "flowgo-1",
    });
  });

  it("keeps an existing server-owned FlowGo session on its pre-rebind Agent", async () => {
    getPairedDeviceMock.mockResolvedValue(flowGoDevice({ boundAgentId: "pet-agent" }));

    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
        existingSessionOwnerDeviceId: "flowgo-1",
        requestedAgentId: "main",
        requestedSessionKey: "agent:main:flowgo-device:flowgo-1:old-conversation",
      }),
    ).resolves.toEqual({
      kind: "route",
      agentId: "main",
      sessionKey: "agent:main:flowgo-device:flowgo-1:old-conversation",
      ownerDeviceId: "flowgo-1",
    });
    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
        existingSessionOwnerDeviceId: "flowgo-1",
        requestedSessionKey: "agent:main:flowgo-device:other-device:old-conversation",
      }),
    ).resolves.toMatchObject({
      kind: "error",
      message: expect.stringContaining("different device"),
    });
  });

  it("does not trust a forged FlowGo-shaped session without persisted ownership", async () => {
    getPairedDeviceMock.mockResolvedValue(flowGoDevice({ boundAgentId: "pet-agent" }));

    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
        requestedSessionKey: "agent:main:flowgo-device:flowgo-1:forged-by-sessions-patch",
      }),
    ).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("pet-agent") });
  });

  it("allows only sessions persisted for the calling FlowGo device", async () => {
    getPairedDeviceMock.mockResolvedValue(flowGoDevice({ boundAgentId: "pet-agent" }));

    await expect(
      authorizeFlowGoOwnedSession({
        client: createClient(),
        ownerDeviceId: "flowgo-1",
      }),
    ).resolves.toEqual({ kind: "allowed", deviceId: "flowgo-1" });
    await expect(
      authorizeFlowGoOwnedSession({
        client: createClient(),
        ownerDeviceId: "other-device",
      }),
    ).resolves.toEqual({
      kind: "error",
      message: "FlowGo session belongs to a different device",
    });
    await expect(
      authorizeFlowGoOwnedSession({
        client: createClient(),
      }),
    ).resolves.toMatchObject({ kind: "error" });
  });

  it("routes /new from an owned pre-rebind session to the current binding", async () => {
    getPairedDeviceMock.mockResolvedValue(flowGoDevice({ boundAgentId: "pet-agent" }));

    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
        existingSessionOwnerDeviceId: "flowgo-1",
        forceNewSession: true,
        requestedAgentId: "main",
        requestedSessionKey: "agent:main:flowgo-device:flowgo-1:old-conversation",
      }),
    ).resolves.toEqual({
      kind: "route",
      agentId: "pet-agent",
      sessionKey: "agent:pet-agent:flowgo-device:flowgo-1:old-conversation",
      ownerDeviceId: "flowgo-1",
    });
  });

  it("accepts only the backing sessionId already owned by the routed key", () => {
    const route = {
      kind: "route" as const,
      agentId: "pet-agent",
      sessionKey: "agent:pet-agent:flowgo-device:flowgo-1:main",
      ownerDeviceId: "flowgo-1",
    };
    expect(
      flowGoRequestedSessionIdMatchesOwnedEntry({
        route,
        requestedSessionId: "owned-session",
        ownedEntrySessionId: "owned-session",
      }),
    ).toBe(true);
    expect(
      flowGoRequestedSessionIdMatchesOwnedEntry({
        route,
        requestedSessionId: "other-device-session",
        ownedEntrySessionId: "owned-session",
      }),
    ).toBe(false);
    expect(
      flowGoRequestedSessionIdMatchesOwnedEntry({
        route,
        requestedSessionId: "other-device-session",
      }),
    ).toBe(false);
  });
});
