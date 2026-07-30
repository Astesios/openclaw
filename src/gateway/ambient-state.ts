// Lightweight in-memory per-session "which app did the user summon me from" state.
//
// FlowOS 半模态面板:用户在**任意 app 前台**长按唤起 floai(或在被子页盖住的 AI 屏上长按),
// 端侧会新建一个会话 + 弹半模态面板,并在建会话那一刻经 node.event(ambient.entered)上报
// 一份"用户是在哪个 app 上唤起的"轻量元信息。get-reply-run 每轮注入 system prompt,让 agent
// 全程"知道"用户在看什么(页面内容仍由 agent 按需 pull:nodes invoke screen.viewtree/capture)。
//
// 与 [collab-state] 的关系:**并列的两种屏幕上下文**,同一套「开头 push 轻量头、AI 按需 pull 细节」
// 分工,共用同一对 node 命令(端侧自己决定读左格还是读前台窗口)。分屏是「左第三方/右 floai」,
// 这个是「用户停在某个 app 上叫了我」。两个块不会同时出现在有意义的场景里,但即便同时出现也无害。
//
// 刻意不持久化:进程内、ephemeral、按 sessionKey 隔离,与 collab-state / system-events 同源思路。
//
// ⚠️ 不设 ambient.exited:端侧**每次唤起半模态面板都新建会话**,状态天然随 sessionKey 作废,
// 不需要显式清理。代价是「面板一直开着、用户中途切到别的 app 再追问」时这份元信息会偏旧 ——
// 故 prompt 里带上 since,并明确告诉 agent 要拿准就重新 pull。

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeInboundSystemTags } from "../security/system-tags.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

export type AmbientState = {
  /** 唤起时前台 app 的包名,如 com.xingin.xhs(经 system-tag 清洗)。 */
  pkg: string | null;
  /** 前台 app 展示名(经清洗),可空。 */
  appLabel: string | null;
  /** 页面标题(端侧尽力而为的启发式,常缺;经清洗)。 */
  title: string | null;
  /** 页面是否可读:安全页 / 树里无节点 → false。 */
  readable: boolean;
  /**
   * 是否是**安全页**(FLAG_SECURE,如银行/密码页)。语义同 [CollabState.secure]:
   *  · secure=true → 树读不到、**截图也拿不到**;
   *  · secure=false 且 readable=false → 只是树空,**截图仍可用**。
   */
  secure: boolean;
  /**
   * 端侧序列化出的文本节点数,0 = 无内容可读。
   *
   * ⚠️ 不是"屏幕上可见的节点数" —— 端侧刻意没做可见性过滤(floai 自己的整屏 overlay 会让被读 app
   * 的所有节点都报 not-visible,过滤等于把树打空)。所以树里可能含隐藏 tab / 预加载内容,
   * 也可能缺已被回收的列表项。
   */
  nodeCount: number;
  /** 唤起时间戳(ms)。 */
  since: number;
};

const AMBIENT_STATE_KEY = Symbol.for("openclaw.ambient.state");

const states = resolveGlobalMap<string, AmbientState>(AMBIENT_STATE_KEY);

/**
 * 归一化到裸 session id。
 *
 * 与 collab-state 完全同款、同一个坑:设备(node.event)发的是裸键 "session_xxx",而 reply 侧
 * (get-reply-run)用的是 agent 作用域键 "agent:<id>:session_xxx"。两端都去掉 "agent:<id>:"
 * 前缀才能存/读同键,否则存进去读不出 → agent 永远看不到这个块。
 */
function requireSessionKey(key?: string | null): string {
  const trimmed = normalizeOptionalString(key) ?? "";
  if (!trimmed) {
    throw new Error("ambient state requires a sessionKey");
  }
  return trimmed.replace(/^agent:[^:]+:/, "");
}

export function setAmbientState(
  sessionKey: string,
  input: {
    pkg?: string | null;
    appLabel?: string | null;
    title?: string | null;
    readable?: boolean;
    secure?: boolean;
    nodeCount?: number;
    since?: number;
  },
): AmbientState {
  const key = requireSessionKey(sessionKey);
  const pkgRaw = normalizeOptionalString(input.pkg);
  const labelRaw = normalizeOptionalString(input.appLabel);
  const titleRaw = normalizeOptionalString(input.title);
  const state: AmbientState = {
    pkg: pkgRaw ? sanitizeInboundSystemTags(pkgRaw) : null,
    appLabel: labelRaw ? sanitizeInboundSystemTags(labelRaw) : null,
    title: titleRaw ? sanitizeInboundSystemTags(titleRaw) : null,
    readable: input.readable === true,
    secure: input.secure === true,
    nodeCount:
      typeof input.nodeCount === "number" && Number.isFinite(input.nodeCount)
        ? Math.max(0, Math.trunc(input.nodeCount))
        : 0,
    since:
      typeof input.since === "number" && Number.isFinite(input.since) ? input.since : Date.now(),
  };
  states.set(key, state);
  return { ...state };
}

export function getAmbientState(sessionKey: string): AmbientState | undefined {
  const existing = states.get(requireSessionKey(sessionKey));
  return existing ? { ...existing } : undefined;
}

export function clearAmbientState(sessionKey: string): void {
  states.delete(requireSessionKey(sessionKey));
}

/**
 * 每轮 prompt 注入的「当前应用」上下文片段。无记录 → 返回 null(不注入)。
 * 只含元信息 + 读屏工具指引;实际页面内容由 agent 按需 pull。
 */
export function buildAmbientContextPrompt(sessionKey?: string | null): string | null {
  // 与 requireSessionKey 同款归一化(见它的注释)。
  const key = normalizeOptionalString(sessionKey)?.replace(/^agent:[^:]+:/, "");
  if (!key) {
    return null;
  }
  const state = states.get(key);
  if (!state) {
    return null;
  }
  const label = state.appLabel ?? state.pkg ?? "未知应用";
  const pkgSuffix = state.pkg && state.appLabel ? `(${state.pkg})` : "";
  const lines = [
    "【当前应用】用户是在下面这个 app 前台唤起你的(半模态面板),不是从桌面进来的。",
    `应用:${label}${pkgSuffix}${state.title ? `;页面标题:${state.title}` : ""};` +
      `页面${
        state.readable
          ? `可读(文本节点 ${state.nodeCount} 个)`
          : state.secure
            ? "不可读(安全页)"
            : "文本树读不到内容(但可截图)"
      }。`,
  ];
  // 三态,别退回「可读/不可读」两态:文本树空 ≠ 什么都看不到,那种页面截图仍然有用。
  if (state.readable) {
    lines.push(
      "当用户问及「这个页面/屏幕上/这条」、或需基于页面信息作答时,用 nodes 工具读取:" +
        "invoke screen.viewtree 取结构化文本树、invoke screen.capture 截图(都不需要传参数,读哪个窗口由端侧决定)。" +
        "不必每轮都读,按需读取;上面的元信息够回答的就直接答,别白读一次。",
    );
  } else if (state.secure) {
    lines.push(
      "页面是安全页(如银行/密码页),**文本树和截图都拿不到**,两种都不要尝试;" +
        "如用户追问,直接说明该页受系统保护、无法读取。",
    );
  } else {
    lines.push(
      "页面文本树读不到内容(多半是自绘界面/游戏/稀疏 Compose 树),**不要用 screen.viewtree**;" +
        "但 **screen.capture 截图仍然可用** —— 需要知道页面显示什么就截图看。",
    );
  }
  lines.push(
    "以上是**唤起那一刻**的快照;若用户中途切到了别的 app 再追问,以重新读取的结果为准。" +
      "当前阶段仅支持读取,不要尝试点击/输入/操作用户的 app。",
  );
  return lines.join("\n");
}
