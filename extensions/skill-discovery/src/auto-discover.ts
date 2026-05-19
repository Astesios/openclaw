// Pre-turn auto-discover pipeline.
//
// Wired from the `before_prompt_build` hook. For every turn:
//   1. Pull the latest user message.
//   2. Pass it through the rule-based judge.
//   3. If the judge says "yes, capability request":
//        a. Hit ClawHub via `searchSkillsFromClawHub`.
//        b. Broadcast `plugin.skill.lifecycle.discover.*` events (so the UI
//           can already animate stage 1 in real time).
//        c. Format the top matches as a short Chinese context block and
//           return it as `prependContext`. The agent now *sees* that the
//           market already has options — it just has to pick one and call
//           install_skill. This removes "should I find?" from the agent's
//           job; only "which one?" remains.
//   4. If the judge says "no", inject nothing. The agent runs untouched.
//
// This is the deterministic "self-audit" layer the user asked for: the
// capability check happens *outside* the persona-heavy main model.

import { searchSkillsFromClawHub } from "openclaw/plugin-sdk/clawhub-skills";
import { broadcastLifecycle } from "./broadcaster.js";
import { extractLatestUserMessage, judgeUserMessage } from "./judge.js";

export type AutoDiscoverResult = {
  prependContext?: string;
};

export async function runAutoDiscover(params: {
  prompt?: string;
  messages: unknown[];
}): Promise<AutoDiscoverResult> {
  // 优先用本回合新发的 prompt；只有 prompt 缺席时才回退到历史。
  // 历史 fallback 也走 judge 内的 stripAutoauditBlocks，避免被之前注入的
  // <skill_market_autoaudit> 块二次命中。
  const userMessage = params.prompt?.trim() || extractLatestUserMessage(params.messages);
  if (!userMessage) {
    return {};
  }

  const judgement = judgeUserMessage(userMessage);
  if (!judgement.trigger || !judgement.query) {
    return {};
  }

  broadcastLifecycle({
    stage: "discover.started",
    query: judgement.query,
    data: { domainLabel: judgement.domainLabel, reason: judgement.reason },
  });

  let matches: Awaited<ReturnType<typeof searchSkillsFromClawHub>> = [];
  try {
    matches = await searchSkillsFromClawHub({ query: judgement.query, limit: 5 });
  } catch (err) {
    broadcastLifecycle({
      stage: "discover.empty",
      query: judgement.query,
      data: { error: err instanceof Error ? err.message : "unknown error" },
    });
    return {};
  }

  if (!matches || matches.length === 0) {
    broadcastLifecycle({ stage: "discover.empty", query: judgement.query });
    return {};
  }

  const topThree = matches.slice(0, 3);
  broadcastLifecycle({
    stage: "discover.found",
    query: judgement.query,
    data: { count: matches.length, top: topThree.map((m) => m.slug) },
  });

  // Build the silent context block the agent will read alongside the user's
  // message. Tone is operational and Chinese-friendly because the surrounding
  // chat is Chinese.
  const lines: string[] = [];
  lines.push(`<skill_market_autoaudit domain="${judgement.domainLabel ?? judgement.query}">`);
  lines.push(
    `已自动检测到用户的能力需求并搜索 ClawHub（query="${judgement.query}"），找到 ${matches.length} 个可用 skill：`,
  );
  topThree.forEach((m, i) => {
    const summary = (m.summary ?? "").replace(/\s+/g, " ").slice(0, 100);
    const name = m.displayName ?? m.slug;
    lines.push(`${i + 1}. slug=\`${m.slug}\` — ${name} :: ${summary}`);
  });
  lines.push(
    "如果想推进，直接调用 `install_skill(slug=…)` 装上其中一个（推荐第 1 个）。聊天文案保持你的人设风格。如果用户不是要这个能力，自然回复即可。",
  );
  lines.push("</skill_market_autoaudit>");

  return { prependContext: lines.join("\n") };
}
