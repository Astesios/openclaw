import { definePluginEntry, injectMessageBySessionKey } from "./api.js";

// nodeSendToSession 从 gateway 进程全局单例读取，无需 bind_broadcaster 预热
// 由 server-node-session-runtime.ts 在 gateway 启动时写入同一 Symbol key
const NODE_SEND_KEY = Symbol.for("openclaw.gateway.nodeSendToSession");
type NodeSendFn = (sessionKey: string, event: string, payload: unknown) => void;

const getNodeSend = (): NodeSendFn | undefined =>
  (globalThis as Record<PropertyKey, unknown>)[NODE_SEND_KEY] as NodeSendFn | undefined;

// ctx.sessionKey 格式为 "agent:agentId:sessionId"（如 "agent:main:main"）
// Node 客户端订阅时使用短 key（如 "main"），需要去掉 "agent:xxx:" 前缀
const toNodeSessionKey = (sessionKey: string | undefined): string =>
  sessionKey?.replace(/^agent:[^:]+:/, "") ?? "main";

export default definePluginEntry({
  id: "celia-canvas",
  name: "Celia Canvas",
  description:
    "结构化卡片推送工具 push_card，替代 celia_card bash 补丁。通过 WS 事件发送到客户端，通过 transcript 注入持久化。",
  register(api) {
    // bind_broadcaster 保留作为兼容接口；推送路径已改走 globalThis 单例，无需再手动调用
    api.registerGatewayMethod(
      "celia_canvas.bind_broadcaster",
      async ({ respond }) => {
        respond(true, { ok: true });
      },
      { scope: "operator.write" },
    );

    api.registerTool(
      (ctx) => ({
        name: "notify_live",
        label: "实况窗通知",
        description:
          "通知 Celia 客户端显示或关闭实况窗。spawn subagent 前调 type=start，收到 announce 后调 type=done。",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["start", "done"],
              description: "start：弹出实况窗；done：关闭实况窗",
            },
            runId: {
              type: "string",
              description: "subagent 的 runId，用于匹配 start/done",
            },
            title: {
              type: "string",
              description: "实况窗标题，type=start 时必填",
            },
            success: {
              type: "boolean",
              description: "任务是否成功，type=done 时使用，默认 true",
            },
          },
          required: ["type", "runId"],
        },
        async execute(
          _toolCallId: string,
          params: { type: "start" | "done"; runId: string; title?: string; success?: boolean },
        ) {
          const nodeSend = getNodeSend();
          if (nodeSend) {
            const command = params.type === "start" ? "canvas.live.start" : "canvas.live.done";
            const payload =
              params.type === "start"
                ? { runId: params.runId, title: params.title ?? "任务进行中" }
                : { runId: params.runId, success: params.success !== false };
            nodeSend(toNodeSessionKey(ctx.sessionKey), command, payload);
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
            details: { ok: true },
          };
        },
      }),
      { name: "notify_live" },
    );

    api.registerTool(
      (ctx) => ({
        name: "push_card",
        label: "推送卡片",
        description:
          "推送结构化卡片到 Celia 客户端。支持空间/文件卡片（resource_card）、酒店/航班/景点模板卡片。" +
          "同时持久化到会话记录以便历史重载。",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description:
                "卡片类型：resource_card | hotel_card | flight_card | scenic_card | poi_card",
            },
            payload: {
              type: "object",
              description:
                "卡片业务数据。resource_card 示例：{resourceType, id, title, subtitle?, thumbnail?, filePath?, action?}；" +
                "模板卡片示例：{summaryText?, items:[...]}",
            },
          },
          required: ["type", "payload"],
        },
        async execute(
          _toolCallId: string,
          params: { type: string; payload: Record<string, unknown> },
        ) {
          const { type, payload } = params;
          const sessionKey = ctx.sessionKey;
          const cardJson = JSON.stringify({ type, ...payload });

          const nodeSend = getNodeSend();
          if (nodeSend) {
            nodeSend(toNodeSessionKey(sessionKey), "canvas.card.push", { cardJson });
          }

          if (sessionKey) {
            injectMessageBySessionKey(sessionKey, `[celia_card]${cardJson}`);
          }

          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ ok: true, _cardRendered: true }) },
            ],
            details: { ok: true, _cardRendered: true },
          };
        },
      }),
      { name: "push_card" },
    );
  },
});
