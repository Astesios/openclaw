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

// ─────────────────────────────────────────────────────────────
// push_card 延迟推送：staging 双索引 Map
//
// 工具执行点只 staging，真正 nodeSend + injectMessageBySessionKey 推迟到 llm_output
// hook 按 lastAssistant.content 的物理顺序分组。多 turn 模型（Gemini）中间 turn
// content 没有 text 时，cards 进 orphaned 队列等下一个 turn 第一个 text anchor。
//
// 协议：canvas.card.push WS payload 加可选字段 anchorTextIndex: number
//   - 有值：客户端按 anchor 把卡绑到本 turn 内第 N 条 AI text bubble 之后浮现
//   - 缺省：客户端立即显示（兼容历史与 agent_end 兜底）
// ─────────────────────────────────────────────────────────────

type StagedCard = { sessionKey: string; cardJson: string; stagedAt: number };

// 按 toolCallId 索引：llm_output 时按 content 顺序配对
const stagedCardsByToolCallId = new Map<string, StagedCard>();
// 按 sessionKey 索引：orphan 队列，处理跨 turn 无对应 text block 的兜底场景
const orphanedCardsBySession = new Map<string, StagedCard[]>();

function hasNonEmptyText(block: unknown): block is { type: "text"; text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string" &&
    (block as { text: string }).text.trim().length > 0
  );
}

function isPushCardToolCall(
  block: unknown,
): block is { type: "toolCall"; id: string; name: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "toolCall" &&
    (block as { name?: unknown }).name === "push_card" &&
    typeof (block as { id?: unknown }).id === "string"
  );
}

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
            icon: {
              type: "string",
              description: "实况窗图标 key，type=start 时填；见 TOOLS.md 可用 key 列表",
            },
            success: {
              type: "boolean",
              description: "任务是否成功，type=done 时使用，默认 true",
            },
            resource: {
              type: "object",
              description:
                "type=done 且任务产出了文件时填写，客户端用于实况窗【查看】按钮直接跳转，无需等待 push_card",
              properties: {
                spaceId: { type: "string", description: "空间 ID，如 sp_xxx" },
                filePath: {
                  type: "string",
                  description: "文件在空间内的相对路径，如 generated/路书.html",
                },
                title: { type: "string", description: "文件标题" },
              },
              required: ["spaceId", "filePath", "title"],
            },
          },
          required: ["type", "runId"],
        },
        async execute(
          _toolCallId: string,
          params: {
            type: "start" | "done";
            runId: string;
            title?: string;
            icon?: string;
            success?: boolean;
            resource?: { spaceId: string; filePath: string; title: string };
          },
        ) {
          const nodeSend = getNodeSend();
          if (nodeSend) {
            const command = params.type === "start" ? "canvas.live.start" : "canvas.live.done";
            const payload =
              params.type === "start"
                ? {
                    runId: params.runId,
                    title: params.title ?? "任务进行中",
                    icon: params.icon ?? "",
                  }
                : {
                    runId: params.runId,
                    success: params.success !== false,
                    resource: params.resource ?? null,
                  };
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
          "推送结构化卡片到 Celia 客户端（同时持久化到会话记录以便历史重载）。" +
          "Agent 推卡片必须调本工具，不要在 assistant text 中写 [celia_card] 标记（已弃用）。",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description:
                "卡片类型：" +
                "space_card（任务空间，含 phase 字段） | " +
                "resource_card（通用资源/文件） | " +
                "hotel_card | flight_card | scenic_card | poi_card（模板卡片）",
            },
            payload: {
              type: "object",
              description:
                "卡片业务数据，按 type 不同字段不同：\n" +
                "- space_card: { phase: 'suggest'|'created', suggestionId, name, " +
                "spaceId?(created必填), subtitle?, tags?, moveFromTemp?, reason? }。" +
                "phase=suggest 时 suggestionId 必填；phase=created 时 spaceId 必填，suggestionId 选填" +
                "（带上则客户端自动合并到原 suggest 卡）。\n" +
                "- resource_card: { resourceType, id, title, subtitle?, thumbnail?, filePath?, action? }。" +
                "新文件用 action:'create' 或省略；更新已有文件才用 action:'update'。\n" +
                "- 模板卡片: { summaryText?, items:[...] }",
            },
          },
          required: ["type", "payload"],
        },
        async execute(
          toolCallId: string,
          params: { type: string; payload: Record<string, unknown> },
        ) {
          const { type, payload } = params;
          const sessionKey = ctx.sessionKey;
          const cardJson = JSON.stringify({ type, ...payload });

          // 不立即 nodeSend / inject。落到 llm_output hook 时按物理顺序分组、再带 anchorTextIndex 推。
          if (sessionKey) {
            const staged: StagedCard = { sessionKey, cardJson, stagedAt: Date.now() };
            stagedCardsByToolCallId.set(toolCallId, staged);
            const orphans = orphanedCardsBySession.get(sessionKey) ?? [];
            orphans.push(staged);
            orphanedCardsBySession.set(sessionKey, orphans);
            api.logger.info(
              `[celia-canvas] push_card staged: toolCallId=${toolCallId} type=${type} sessionKey=${sessionKey} totalStaged=${stagedCardsByToolCallId.size}`,
            );
          }

          // 返回 _cardRendered: true 保持和 Agent prompt（TOOLS.md / 各 SKILL）的契约不变 ——
          // 虽然实际推送延后到 llm_output hook，但 Agent 看到此信号即认为推送已落实，
          // 不应重复 push 同张卡。这条契约是改造前后 Agent 行为兼容的关键。
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

    // 主路径：llm_output 按 lastAssistant.content 物理顺序把 staged 卡片分组到对应 text anchor
    api.on("llm_output", (event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        api.logger.info("[celia-canvas] llm_output: no sessionKey in ctx, skipping");
        return;
      }
      const last = (event as { lastAssistant?: { content?: unknown } }).lastAssistant;
      const content = Array.isArray(last?.content) ? (last.content as unknown[]) : [];
      const blockSummary = content
        .map((b) => {
          const o = b as { type?: unknown; name?: unknown; text?: unknown };
          if (o.type === "text") {
            const t = typeof o.text === "string" ? o.text : (JSON.stringify(o.text) ?? "");
            return `text(${t.slice(0, 20).replace(/\n/g, "\\n")}|len=${t.length})`;
          }
          if (o.type === "toolCall") {
            return `tool(${String(o.name)})`;
          }
          return String(o.type);
        })
        .join(",");
      api.logger.info(
        `[celia-canvas] llm_output: sessionKey=${sessionKey} provider=${(event as { provider?: string }).provider} blocks=[${blockSummary}] stagedCount=${stagedCardsByToolCallId.size} orphans=${(orphanedCardsBySession.get(sessionKey) ?? []).length}`,
      );
      if (content.length === 0) {
        return;
      }

      // 按物理顺序扫描：text(非空) → anchor++；toolCall(push_card) → 绑到当前 anchor
      let currentAnchor = -1;
      const groups: { anchor: number; cards: StagedCard[] }[] = [];
      for (const block of content) {
        if (hasNonEmptyText(block)) {
          currentAnchor++;
          groups.push({ anchor: currentAnchor, cards: [] });
        } else if (isPushCardToolCall(block)) {
          const staged = stagedCardsByToolCallId.get(block.id);
          if (staged && groups.length > 0) {
            groups[groups.length - 1].cards.push(staged);
            stagedCardsByToolCallId.delete(block.id);
            const orphans = orphanedCardsBySession.get(staged.sessionKey);
            if (orphans) {
              const idx = orphans.indexOf(staged);
              if (idx >= 0) {
                orphans.splice(idx, 1);
              }
            }
          }
        }
      }

      // 本 turn 之前 turn 留下的 orphan（如 Gemini 中间 toolUse turn 没 text）→
      // 在本 turn 有 anchor 时全部塞到第一个 anchor 前；没 anchor 就继续留着等下一个 turn
      if (groups.length > 0) {
        const orphans = orphanedCardsBySession.get(sessionKey) ?? [];
        const carryOver = orphans.filter((s) => !groups.some((g) => g.cards.includes(s)));
        if (carryOver.length > 0) {
          groups[0].cards.unshift(...carryOver);
          // 从 orphans 清掉已 carry-over 的项
          const remaining = orphans.filter((s) => !carryOver.includes(s));
          if (remaining.length === 0) {
            orphanedCardsBySession.delete(sessionKey);
          } else {
            orphanedCardsBySession.set(sessionKey, remaining);
          }
          // 同时清 toolCallId map（carry-over 已不再有 staging 意义）
          for (const s of carryOver) {
            for (const [id, st] of stagedCardsByToolCallId) {
              if (st === s) {
                stagedCardsByToolCallId.delete(id);
                break;
              }
            }
          }
        }
      }

      // flush：按 anchor 顺序 nodeSend WS + injectMessageBySessionKey transcript
      const nodeSend = getNodeSend();
      const nodeKey = toNodeSessionKey(sessionKey);
      const flushedSummary = groups.map((g) => `anchor#${g.anchor}=[${g.cards.length}]`).join(",");
      api.logger.info(`[celia-canvas] llm_output flush: ${flushedSummary || "(empty)"}`);
      for (const g of groups) {
        for (const { cardJson } of g.cards) {
          if (nodeSend) {
            nodeSend(nodeKey, "canvas.card.push", { cardJson, anchorTextIndex: g.anchor });
          }
          injectMessageBySessionKey(sessionKey, `[celia_card]${cardJson}`);
        }
      }
    });

    // 关于 agent_end：**不要**在这里 flush orphans。
    // 实测 pi-embedded-runner/run/attempt.ts 中 hook 顺序为 agent_end 先于 llm_output（line 2480 vs 2578），
    // 而且都是 per-attempt 触发（一次 agent run 多次 attempt）。若 agent_end flush orphan 会把还没等到
    // 下一个 attempt llm_output 文本 anchor 的卡片提前打掉，导致 anchor=null 失序。
    //
    // 代价：极端 case "Agent 推卡后真的不再说一句话" 时，orphans 沉睡到 session_end 才清，UI 不显示卡片。
    // 实际场景里 LLM 调完 tools 通常会再发起一次 attempt 总结结果，触发文本 anchor + carry-over → 正常 flush。

    // 清理：session 结束 / 用户中断 / 超时 → 丢弃所有 staging
    api.on("session_end", (_event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        return;
      }
      orphanedCardsBySession.delete(sessionKey);
      for (const [id, staged] of stagedCardsByToolCallId) {
        if (staged.sessionKey === sessionKey) {
          stagedCardsByToolCallId.delete(id);
        }
      }
    });
  },
});
