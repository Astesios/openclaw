// Lightweight in-memory per-session split-screen (collab) state.
//
// FlowOS 折叠机分屏协作态:第三方 app 在左、floai AI 在右。设备在进/出分屏时经
// node.event(collab.entered/exited)上报,这里按 sessionKey 常驻一份"当前左侧是什么、
// 能否读"的元信息。get-reply-run 每轮把它注入 system prompt,让 agent 全程"知道"自己
// 在分屏、左边是谁(内容仍由 agent 按需 pull:nodes invoke screen.viewtree/capture)。
//
// 刻意不持久化:进程内、ephemeral、按 sessionKey 隔离,与 system-events 同源思路。

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeInboundSystemTags } from "../security/system-tags.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

export type CollabState = {
  /** 左侧 app 包名,如 com.tencent.mm(经 system-tag 清洗)。 */
  leftPackage: string | null;
  /** 左侧 app 展示名 / 窗口标题(经清洗),可空。 */
  leftAppLabel: string | null;
  /** 左侧内容是否可读:安全页 / 树里无节点 → false。 */
  readable: boolean;
  /**
   * 左侧是否是**安全页**(FLAG_SECURE,如银行/密码页)。
   *
   * 与 readable 分开是因为「读不出」有两种、能做的事不一样:
   *  · secure=true → 树读不到、**截图也拿不到**,两条路都别试;
   *  · secure=false 且 readable=false → 树是空的(自绘 Canvas/游戏/稀疏 Compose 树),
   *    但**截图照样能看**。只有一个布尔时会把后者的截图路也一起劝退。
   */
  secure: boolean;
  /** 进入分屏的时间戳(ms)。 */
  since: number;
};

const COLLAB_STATE_KEY = Symbol.for("openclaw.collab.state");

const states = resolveGlobalMap<string, CollabState>(COLLAB_STATE_KEY);

function requireSessionKey(key?: string | null): string {
  const trimmed = normalizeOptionalString(key) ?? "";
  if (!trimmed) {
    throw new Error("collab state requires a sessionKey");
  }
  // 归一化到裸 session id:设备(node.event)发的是裸键 "session_xxx",而 reply 侧(get-reply-run)
  // 用的是 agent 作用域键 "agent:<id>:session_xxx"。两端都去掉 "agent:<id>:" 前缀,保证存/读同键,
  // 否则 collab 状态存进去却读不出 → agent 误判"不在分屏"。
  return trimmed.replace(/^agent:[^:]+:/, "");
}

export function setCollabState(
  sessionKey: string,
  input: {
    leftPackage?: string | null;
    leftAppLabel?: string | null;
    readable?: boolean;
    secure?: boolean;
    since?: number;
  },
): CollabState {
  const key = requireSessionKey(sessionKey);
  const leftPackageRaw = normalizeOptionalString(input.leftPackage);
  const leftLabelRaw = normalizeOptionalString(input.leftAppLabel);
  const state: CollabState = {
    leftPackage: leftPackageRaw ? sanitizeInboundSystemTags(leftPackageRaw) : null,
    leftAppLabel: leftLabelRaw ? sanitizeInboundSystemTags(leftLabelRaw) : null,
    readable: input.readable === true,
    secure: input.secure === true,
    since:
      typeof input.since === "number" && Number.isFinite(input.since) ? input.since : Date.now(),
  };
  states.set(key, state);
  return { ...state };
}

export function getCollabState(sessionKey: string): CollabState | undefined {
  const existing = states.get(requireSessionKey(sessionKey));
  return existing ? { ...existing } : undefined;
}

export function clearCollabState(sessionKey: string): void {
  states.delete(requireSessionKey(sessionKey));
}

/**
 * 每轮 prompt 注入的分屏上下文片段(持续感知)。无分屏 → 返回 null(不注入)。
 * 内容仅元信息(左侧是谁/能否读)+ 读屏工具指引;实际内容由 agent 按需 pull。
 */
export function buildCollabContextPrompt(sessionKey?: string | null): string | null {
  // 与 requireSessionKey 同款归一化:去 "agent:<id>:" 前缀,保证与 setCollabState 存的键一致。
  const key = normalizeOptionalString(sessionKey)?.replace(/^agent:[^:]+:/, "");
  if (!key) {
    return null;
  }
  const state = states.get(key);
  if (!state) {
    return null;
  }
  const label = state.leftAppLabel ?? state.leftPackage ?? "未知应用";
  const pkgSuffix = state.leftPackage && state.leftAppLabel ? `(${state.leftPackage})` : "";
  const lines = [
    "【分屏协作态】当前处于折叠机分屏:左侧是第三方 app,右侧是你(floai)。",
    `左侧应用:${label}${pkgSuffix};左侧内容${
      state.readable ? "可读" : state.secure ? "不可读(安全页)" : "文本树读不到内容(但可截图)"
    }。`,
  ];
  // 三态,别退回「可读/不可读」两态:文本树空 ≠ 什么都看不到,那种页面截图仍然有用。
  if (state.readable) {
    lines.push(
      // ⚠️ 别写 {pane:'left'}:端侧压根不读这个参数(读哪个窗口由端侧按分屏/前台自行判定),
      // 而 skill 文档明确写「不需要也不要传 pane」。这里若还教 agent 传,两边指令互相矛盾。
      "当用户问及左侧、或需基于左侧信息作答时,用 nodes 工具读取左屏:" +
        "invoke screen.viewtree 取结构化文本树、invoke screen.capture 截图(都不需要传参数)。" +
        "不必每轮都读,按需读取。",
    );
  } else if (state.secure) {
    lines.push(
      "左侧是安全页(如银行/密码页),**文本树和截图都拿不到**,两种都不要尝试;" +
        "如用户追问,直接说明该页受系统保护、无法读取。",
    );
  } else {
    lines.push(
      "左侧文本树读不到内容(多半是自绘界面/游戏/稀疏 Compose 树),**不要用 screen.viewtree**;" +
        "但 **screen.capture 截图仍然可用** —— 需要知道左侧显示什么就截图看。",
    );
  }
  lines.push("当前阶段仅支持读取左侧,不要尝试点击/输入/操作左侧。");
  return lines.join("\n");
}
