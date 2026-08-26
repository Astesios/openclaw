import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyDeviceToken } from "../../src/infra/device-pairing.js";
import plugin from "./index.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const temporaryDirs: string[] = [];

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  for (const directory of temporaryDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("FlowOS device onboarding provisioning", () => {
  it("creates a real paired identity whose returned token passes Gateway verification", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowos-onboarding-pairing-"));
    temporaryDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const registerGatewayMethod = vi.fn();
    plugin.register({
      pluginConfig: { userId: "alice", tenantId: "tenant-a" },
      config: { gateway: { auth: {} } },
      registerGatewayMethod,
      registerTool: vi.fn(),
      runtime: {
        state: {
          openKeyedStore: () => ({ register: vi.fn(), lookup: vi.fn() }),
        },
      },
    } as never);
    const registration = registerGatewayMethod.mock.calls.find(
      ([name]) => name === "flowos.deviceOnboardingProvision",
    ) as [string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1], { scope: string }];
    expect(registration[2]).toEqual({ scope: "operator.admin" });
    const respond = vi.fn();
    await registration[1]({
      req: {} as never,
      params: {
        deviceId: "flowgo-integration-1",
        devicePublicKey: "ed25519-integration-public-key-material",
      },
      client: {
        isDeviceTokenAuth: true,
        connect: {
          role: "operator",
          scopes: ["operator.read", "operator.write", "operator.admin"],
          device: { id: "android-owner" },
        },
      } as never,
      isWebchatConnect: () => false,
      context: {} as GatewayRequestHandlerOptions["context"],
      respond,
    });

    expect(respond.mock.calls[0][0]).toBe(true);
    const result = respond.mock.calls[0][1] as { deviceId: string; deviceToken: string };
    expect(result.deviceId).toBe("flowgo-integration-1");
    await expect(
      verifyDeviceToken({
        deviceId: result.deviceId,
        token: result.deviceToken,
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      }),
    ).resolves.toEqual({ ok: true });
  });
});
