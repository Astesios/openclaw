import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PairedDevice } from "../infra/device-pairing.js";
import { resolveFlowGoNewSessionRoute } from "./flowgo-device-routing.js";
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
        existingSession: false,
        requestedSessionKey: "main",
      }),
    ).resolves.toEqual({
      kind: "route",
      agentId: "pet-agent",
      sessionKey: "agent:pet-agent:main",
    });
  });

  it("uses the default Agent for a compatible historical unbound FlowGo record", async () => {
    getPairedDeviceMock.mockResolvedValue(flowGoDevice());

    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
        existingSession: false,
      }),
    ).resolves.toEqual({ kind: "route", agentId: "main", sessionKey: undefined });
  });

  it("rejects a client-reported Agent or session key that differs from the binding", async () => {
    getPairedDeviceMock.mockResolvedValue(flowGoDevice({ boundAgentId: "pet-agent" }));

    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
        existingSession: false,
        requestedAgentId: "main",
      }),
    ).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("pet-agent") });
    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
        existingSession: false,
        requestedSessionKey: "agent:main:main",
      }),
    ).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("pet-agent") });
  });

  it("fails closed when the bound Agent or paired device is unavailable", async () => {
    getPairedDeviceMock.mockResolvedValueOnce(flowGoDevice({ boundAgentId: "deleted-agent" }));
    await expect(
      resolveFlowGoNewSessionRoute({ client: createClient(), cfg, existingSession: false }),
    ).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("rebind") });

    getPairedDeviceMock.mockResolvedValueOnce(null);
    await expect(
      resolveFlowGoNewSessionRoute({ client: createClient(), cfg, existingSession: false }),
    ).resolves.toEqual({ kind: "error", message: "paired device is no longer available" });
  });

  it("does not migrate existing sessions or route ordinary/shared-auth clients", async () => {
    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(),
        cfg,
        existingSession: true,
        requestedAgentId: "main",
        requestedSessionKey: "agent:main:existing",
      }),
    ).resolves.toEqual({ kind: "unchanged" });
    await expect(
      resolveFlowGoNewSessionRoute({
        client: createClient(false),
        cfg,
        existingSession: false,
        requestedAgentId: "main",
      }),
    ).resolves.toEqual({ kind: "unchanged" });
    expect(getPairedDeviceMock).not.toHaveBeenCalled();
  });
});
