import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type StoredBinding = Record<string, unknown>;
type GatewayMethodRegistration = [
  string,
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1],
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2],
];
type GatewayHandler = GatewayMethodRegistration[1];

async function invoke(
  handler: GatewayHandler,
  values: Pick<GatewayRequestHandlerOptions, "params" | "client" | "respond">,
): Promise<void> {
  await handler({
    req: {} as never,
    isWebchatConnect: () => false,
    context: {} as never,
    ...values,
  });
}

function writeDeviceSecret(secret = "d".repeat(48), mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowos-device-jwt-"));
  tempDirs.push(dir);
  const file = path.join(dir, "device-event-jwt.secret");
  fs.writeFileSync(file, secret, { mode });
  fs.chmodSync(file, mode);
  process.env.FLOWOS_DEVICE_EVENT_JWT_SECRET_FILE = file;
  return secret;
}

function setup(gatewayCredential?: string) {
  const records = new Map<string, StoredBinding>();
  const registerGatewayMethod = vi.fn();
  plugin.register({
    pluginConfig: { userId: "alice", tenantId: "tenant-a" },
    config: { gateway: { auth: { token: gatewayCredential } } },
    registerGatewayMethod,
    runtime: {
      state: {
        openKeyedStore: () => ({
          register: async (key: string, value: StoredBinding) => {
            records.set(key, value);
          },
          lookup: async (key: string) => records.get(key),
        }),
      },
    },
  } as never);
  return { calls: registerGatewayMethod.mock.calls, records };
}

function method(calls: unknown[][], name: string): GatewayMethodRegistration {
  const registration = calls.find(([registeredName]) => registeredName === name);
  if (!registration) {
    throw new Error(`missing gateway method: ${name}`);
  }
  return registration as GatewayMethodRegistration;
}

function gatewayClient(
  value: Record<string, unknown>,
): NonNullable<GatewayRequestHandlerOptions["client"]> {
  return value as never;
}

function pairedOperator(gatewayDeviceId = "android-fingerprint") {
  return gatewayClient({
    id: "android-client",
    isDeviceTokenAuth: true,
    connect: { role: "operator", device: { id: gatewayDeviceId } },
  });
}

function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

async function upsertBinding(calls: unknown[][], overrides: Record<string, unknown> = {}) {
  const [, handler] = method(calls, "flowos.deviceEventBinding.upsert");
  const respond = vi.fn();
  await invoke(handler, {
    params: {
      gatewayDeviceId: "android-fingerprint",
      hubDeviceId: "hs-abc12345",
      tenantId: "tenant-a",
      subjectUserId: "alice",
      ...overrides,
    },
    client: pairedOperator("admin-device"),
    respond,
  });
  expect(respond.mock.calls[0][0]).toBe(true);
}

describe("flowos task-center auth", () => {
  it("registers a paired-device-only read method and signs server-bound identity", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const { calls } = setup();
    const [name, handler, options] = method(calls, "flowos.taskCenterToken");
    expect(name).toBe("flowos.taskCenterToken");
    expect(options).toEqual({ scope: "operator.read" });
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond });
    const claims = decodeClaims(respond.mock.calls[0][1].accessToken);
    expect(respond.mock.calls[0][0]).toBe(true);
    expect(claims).toMatchObject({
      aud: "assist:task-center",
      sub: "user:alice",
      tenantId: "tenant-a",
      actorType: "USER",
      scope: "",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
  });

  it("keeps the MiniApp audience and scopes separate", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const { calls } = setup();
    const [, handler] = method(calls, "flowos.miniAppToken");
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond });
    const claims = decodeClaims(respond.mock.calls[0][1].accessToken);
    expect(claims.aud).toBe("assist:miniapps");
    expect(String(claims.scope).split(" ")).toEqual([
      "miniapp.data.read",
      "miniapp.data.write",
      "miniapp.inbox.read",
      "miniapp.inbox.ack",
      "miniapp.function.invoke",
    ]);
  });
});

describe("FlowOS Device Event identity", () => {
  it("persists an admin-managed binding and issues exact five-minute device claims", async () => {
    writeDeviceSecret();
    const { calls, records } = setup();
    expect(method(calls, "flowos.deviceEventBinding.upsert")[2]).toEqual({
      scope: "operator.admin",
    });
    await upsertBinding(calls);
    expect(records.get("android-fingerprint")).toMatchObject({
      gatewayDeviceId: "android-fingerprint",
      hubDeviceId: "hs-abc12345",
      tenantId: "tenant-a",
      subjectUserId: "alice",
      status: "active",
    });

    const [, handler, options] = method(calls, "flowos.deviceEventToken");
    expect(options).toEqual({ scope: "operator.read" });
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond });
    expect(respond.mock.calls[0][0]).toBe(true);
    const payload = respond.mock.calls[0][1];
    const claims = decodeClaims(payload.accessToken);
    expect(payload).toMatchObject({ tokenType: "Bearer", expiresIn: 300 });
    expect(claims).toMatchObject({
      iss: "flowos-device-identity",
      aud: "assist:device-events",
      sub: "device:hs-abc12345",
      actorType: "DEVICE",
      deviceId: "hs-abc12345",
      tenantId: "tenant-a",
      subjectUserId: "alice",
      scope: "device.event.write",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
    expect(typeof claims.jti).toBe("string");
  });

  it("creates a unique jti for every issuance", async () => {
    writeDeviceSecret();
    const { calls } = setup();
    await upsertBinding(calls);
    const [, handler] = method(calls, "flowos.deviceEventToken");
    const first = vi.fn();
    const second = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond: first });
    await invoke(handler, { params: {}, client: pairedOperator(), respond: second });
    expect(decodeClaims(first.mock.calls[0][1].accessToken).jti).not.toBe(
      decodeClaims(second.mock.calls[0][1].accessToken).jti,
    );
  });

  it.each([
    [
      "shared gateway auth",
      gatewayClient({ isDeviceTokenAuth: false, connect: { role: "operator" } }),
    ],
    [
      "node role",
      gatewayClient({
        isDeviceTokenAuth: true,
        connect: { role: "node", device: { id: "android-fingerprint" } },
      }),
    ],
    ["wrong device", pairedOperator("another-android")],
  ])("rejects %s", async (_label, client) => {
    writeDeviceSecret();
    const { calls } = setup();
    await upsertBinding(calls);
    const [, handler] = method(calls, "flowos.deviceEventToken");
    const respond = vi.fn();
    await invoke(handler, { params: {}, client, respond });
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it("rejects caller-supplied identity parameters", async () => {
    writeDeviceSecret();
    const { calls } = setup();
    await upsertBinding(calls);
    const [, handler] = method(calls, "flowos.deviceEventToken");
    const respond = vi.fn();
    await invoke(handler, {
      params: { deviceId: "hs-mallory", tenantId: "other", subjectUserId: "mallory" },
      client: pairedOperator(),
      respond,
    });
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it("revokes a binding without deleting its audit record", async () => {
    writeDeviceSecret();
    const { calls, records } = setup();
    await upsertBinding(calls);
    const [, revoke] = method(calls, "flowos.deviceEventBinding.revoke");
    const revoked = vi.fn();
    await invoke(revoke, {
      params: { gatewayDeviceId: "android-fingerprint" },
      client: pairedOperator("admin-device"),
      respond: revoked,
    });
    expect(records.get("android-fingerprint")).toMatchObject({ status: "revoked" });
    const [, issue] = method(calls, "flowos.deviceEventToken");
    const respond = vi.fn();
    await invoke(issue, { params: {}, client: pairedOperator(), respond });
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it.each([
    ["missing", undefined, undefined],
    ["insecure permissions", "d".repeat(48), 0o644],
    ["too short", "short", 0o600],
    ["reused credential", "r".repeat(48), 0o600],
    ["reused configured gateway token", "g".repeat(48), 0o600],
  ])("fails closed when the signing secret is %s", async (_label, secret, mode) => {
    if (secret !== undefined && mode !== undefined) {
      writeDeviceSecret(secret, mode);
    }
    if (_label === "reused credential") {
      process.env.FLOWOS_TASK_CENTER_JWT_SECRET = secret;
    }
    const { calls } = setup(_label === "reused configured gateway token" ? secret : undefined);
    await upsertBinding(calls);
    const [, handler] = method(calls, "flowos.deviceEventToken");
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond });
    expect(respond.mock.calls[0]).toEqual([
      false,
      undefined,
      { code: "UNAVAILABLE", message: "device event authentication is not configured" },
    ]);
  });
});
