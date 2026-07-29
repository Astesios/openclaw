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
  /** 左侧内容是否可读:FLAG_SECURE / 无内容 → false。 */
  readable: boolean;
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
    `左侧应用:${label}${pkgSuffix};左侧内容${state.readable ? "可读" : "不可读(安全页/无内容)"}。`,
  ];
  if (state.readable) {
    lines.push(
      "当用户问及左侧、或需基于左侧信息作答时,用 nodes 工具读取左屏:" +
        "invoke screen.viewtree {pane:'left'} 取结构化文本树、invoke screen.capture {pane:'left'} 截图。" +
        "不必每轮都读,按需读取。",
    );
  } else {
    lines.push("左侧不可读(如银行/密码页),不要尝试读取;如用户追问,直接说明该页无法读取。");
  }
  lines.push("当前阶段仅支持读取左侧,不要尝试点击/输入/操作左侧。");
  return lines.join("\n");
}
