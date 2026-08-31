import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { agentHandlers } from "./agent.js";
import { chatHandlers } from "./chat.js";
import { sessionsHandlers } from "./sessions.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";
import { usageHandlers } from "./usage.js";

const resolveFlowGoNewSessionRouteMock = vi.hoisted(() => vi.fn());
const resolveFlowGoCallerMock = vi.hoisted(() => vi.fn());
const authorizeFlowGoOwnedSessionMock = vi.hoisted(() => vi.fn());
const loadCombinedSessionStoreForGatewayMock = vi.hoisted(() => vi.fn());
const listSessionsFromStoreAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("../flowgo-device-routing.js", () => ({
  authorizeFlowGoOwnedSession: authorizeFlowGoOwnedSessionMock,
  resolveFlowGoCaller: resolveFlowGoCallerMock,
  resolveFlowGoNewSessionRoute: resolveFlowGoNewSessionRouteMock,
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: loadCombinedSessionStoreForGatewayMock,
    listSessionsFromStoreAsync: listSessionsFromStoreAsyncMock,
  };
});

vi.mock("./optional-model-catalog.js", () => ({
  loadOptionalServerMethodModelCatalog: vi.fn(async () => []),
}));

function createOptions(
  method: string,
  params: Record<string, unknown>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method, params },
    params,
    respond: vi.fn() as unknown as RespondFn,
    context: {
      getRuntimeConfig: () => ({ agents: { list: [{ id: "main" }, { id: "pet-agent" }] } }),
      loadGatewayModelCatalog: async () => [],
    },
    client: null,
    isWebchatConnect: () => false,
  } as unknown as GatewayRequestHandlerOptions;
}

describe("FlowGo new-session handler wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveFlowGoCallerMock.mockResolvedValue({ kind: "unchanged" });
    authorizeFlowGoOwnedSessionMock.mockResolvedValue({
      kind: "allowed",
      deviceId: "flowgo-1",
    });
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "/tmp/sessions.json",
      store: {},
    });
    listSessionsFromStoreAsyncMock.mockImplementation(async ({ store }) => {
      const sessions = Object.entries(store).map(([key, entry]) => Object.assign({ key }, entry));
      return {
        ts: 1,
        path: "/tmp/sessions.json",
        count: sessions.length,
        totalCount: sessions.length,
        limitApplied: 1,
        hasMore: false,
        defaults: {},
        sessions,
      };
    });
    resolveFlowGoNewSessionRouteMock.mockResolvedValue({
      kind: "error",
      message: "FlowGo device Agent is unavailable; rebind the device before starting a session",
    });
  });

  it.each([
    [
      "agent",
      agentHandlers.agent,
      { message: "hello", idempotencyKey: "run-1", sessionKey: "main" },
    ],
    [
      "chat.send",
      chatHandlers["chat.send"],
      { message: "hello", idempotencyKey: "run-1", sessionKey: "main" },
    ],
    ["sessions.create", sessionsHandlers["sessions.create"], { key: "main" }],
  ])(
    "fails closed in the %s handler before creating a session",
    async (method, handler, params) => {
      const opts = createOptions(method, params);

      await handler(opts);

      expect(resolveFlowGoNewSessionRouteMock).toHaveBeenCalledTimes(1);
      expect(opts.respond).toHaveBeenCalledWith(false, undefined, {
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("rebind"),
      });
    },
  );

  it.each([
    ["sessions.get", sessionsHandlers["sessions.get"], { key: "agent:main:other" }],
    ["chat.history", chatHandlers["chat.history"], { sessionKey: "agent:main:other" }],
    [
      "chat.message.get",
      chatHandlers["chat.message.get"],
      { sessionKey: "agent:main:other", messageId: "message-1" },
    ],
    ["chat.abort", chatHandlers["chat.abort"], { sessionKey: "agent:main:other" }],
    ["sessions.usage", usageHandlers["sessions.usage"], { key: "agent:main:other" }],
    [
      "sessions.usage.timeseries",
      usageHandlers["sessions.usage.timeseries"],
      { key: "agent:main:other" },
    ],
    ["sessions.usage.logs", usageHandlers["sessions.usage.logs"], { key: "agent:main:other" }],
  ])(
    "rejects a FlowGo read through %s when the persisted owner differs",
    async (method, handler, params) => {
      resolveFlowGoCallerMock.mockResolvedValue({ kind: "flowgo", deviceId: "flowgo-1" });
      authorizeFlowGoOwnedSessionMock.mockResolvedValue({
        kind: "error",
        message: "FlowGo session belongs to a different device",
      });
      const opts = createOptions(method, params);

      await handler(opts);

      expect(opts.respond).toHaveBeenCalledWith(false, undefined, {
        code: ErrorCodes.INVALID_REQUEST,
        message: "FlowGo session belongs to a different device",
      });
    },
  );

  it("rejects a FlowGo child session whose parent is not owned by the device", async () => {
    resolveFlowGoCallerMock.mockResolvedValue({ kind: "flowgo", deviceId: "flowgo-1" });
    authorizeFlowGoOwnedSessionMock.mockResolvedValue({
      kind: "error",
      message: "FlowGo session belongs to a different device",
    });
    const opts = createOptions("sessions.create", {
      key: "main",
      parentSessionKey: "agent:main:other",
    });

    await sessionsHandlers["sessions.create"](opts);

    expect(resolveFlowGoNewSessionRouteMock).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "FlowGo session belongs to a different device",
    });
  });

  it("filters FlowGo sessions before list pagination and counts", async () => {
    resolveFlowGoCallerMock.mockResolvedValue({ kind: "flowgo", deviceId: "flowgo-1" });
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:owned": {
          sessionId: "owned-session",
          updatedAt: 20,
          flowGoOwnerDeviceId: "flowgo-1",
        },
        "agent:main:foreign": {
          sessionId: "foreign-session",
          updatedAt: 30,
          flowGoOwnerDeviceId: "flowgo-2",
        },
      },
    });
    const opts = createOptions("sessions.list", { limit: 1, offset: 0 });

    await sessionsHandlers["sessions.list"](opts);

    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        count: 1,
        totalCount: 1,
        hasMore: false,
        sessions: [expect.objectContaining({ key: "agent:main:owned" })],
      }),
      undefined,
    );
  });

  it("does not aggregate unowned sessions for a FlowGo usage query without a key", async () => {
    resolveFlowGoCallerMock.mockResolvedValue({ kind: "flowgo", deviceId: "flowgo-1" });
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:foreign": {
          sessionId: "foreign-session",
          updatedAt: 30,
          flowGoOwnerDeviceId: "flowgo-2",
        },
      },
    });
    const opts = createOptions("sessions.usage", {});

    await usageHandlers["sessions.usage"](opts);

    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessions: [], totals: expect.objectContaining({ totalCost: 0 }) }),
      undefined,
    );
  });
});
