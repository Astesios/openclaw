import { definePluginEntry, injectMessageBySessionKey } from "./api.js";

// nodeSendToSession 从 gateway 进程全局单例读取，无需 bind_broadcaster 预热
// 由 server-node-session-runtime.ts 在 gateway 启动时写入同一 Symbol key
const NODE_SEND_KEY = Symbol.for("openclaw.gateway.nodeSendToSession");
type NodeSendFn = (sessionKey: string, event: string, payload: unknown) => void;

const getNodeSend = (): NodeSendFn | undefined =>
  (globalThis as Record<PropertyKey, unknown>)[NODE_SEND_KEY] as NodeSendFn | undefined;

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
          if (nodeSend && sessionKey) {
            nodeSend(sessionKey, "canvas.card.push", { cardJson });
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
