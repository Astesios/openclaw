import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const originalSecret = process.env.FLOWOS_TASK_CENTER_JWT_SECRET;

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.FLOWOS_TASK_CENTER_JWT_SECRET;
  } else {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = originalSecret;
  }
});

function setup() {
  const registerGatewayMethod = vi.fn();
  plugin.register({
    pluginConfig: { userId: "alice", tenantId: "tenant-a" },
    registerGatewayMethod,
  } as never);
  return registerGatewayMethod.mock.calls;
}

function method(name: string) {
  const registration = setup().find(([registeredName]) => registeredName === name);
  if (!registration) {
    throw new Error(`missing gateway method: ${name}`);
  }
  return registration;
}

describe("flowos task-center auth", () => {
  it("registers a paired-device-only read method and signs server-bound identity", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const [name, handler, options] = method("flowos.taskCenterToken");
    expect(name).toBe("flowos.taskCenterToken");
    expect(options).toEqual({ scope: "operator.read" });
    const respond = vi.fn();
    await handler({
      params: {},
      client: { isDeviceTokenAuth: true, connect: { device: { id: "phone" } } },
      respond,
    });
    const payload = respond.mock.calls[0][1];
    const claims = JSON.parse(
      Buffer.from(payload.accessToken.split(".")[1], "base64url").toString(),
    );
    expect(respond.mock.calls[0][0]).toBe(true);
    expect(claims).toMatchObject({
      aud: "assist:task-center",
      sub: "user:alice",
      tenantId: "tenant-a",
      actorType: "USER",
      scope: "",
    });
    expect(claims.exp - claims.iat).toBe(300);
  });

  it("issues a separate audience-bound MiniApp token with explicit scopes", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const [name, handler, options] = method("flowos.miniAppToken");
    expect(name).toBe("flowos.miniAppToken");
    expect(options).toEqual({ scope: "operator.read" });
    const respond = vi.fn();
    await handler({
      params: {},
      client: { isDeviceTokenAuth: true, connect: { device: { id: "phone" } } },
      respond,
    });
    const claims = JSON.parse(
      Buffer.from(respond.mock.calls[0][1].accessToken.split(".")[1], "base64url").toString(),
    );
    expect(respond.mock.calls[0][0]).toBe(true);
    expect(claims).toMatchObject({
      aud: "assist:miniapps",
      sub: "user:alice",
      tenantId: "tenant-a",
      actorType: "USER",
    });
    expect(claims.scope.split(" ")).toEqual([
      "miniapp.data.read",
      "miniapp.data.write",
      "miniapp.inbox.read",
      "miniapp.inbox.ack",
      "miniapp.function.invoke",
    ]);
    expect(claims.exp - claims.iat).toBe(300);
  });

  it("rejects shared gateway auth and caller-supplied identity", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const [, handler] = method("flowos.miniAppToken");
    const sharedRespond = vi.fn();
    await handler({
      params: {},
      client: { isDeviceTokenAuth: false, connect: { device: { id: "phone" } } },
      respond: sharedRespond,
    });
    expect(sharedRespond.mock.calls[0][0]).toBe(false);
    const spoofRespond = vi.fn();
    await handler({
      params: { userId: "mallory" },
      client: { isDeviceTokenAuth: true, connect: { device: { id: "phone" } } },
      respond: spoofRespond,
    });
    expect(spoofRespond.mock.calls[0][0]).toBe(false);
  });
});
