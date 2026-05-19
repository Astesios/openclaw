// Strong guidance: the agent must self-audit before answering. Phrased
// imperatively because permissive phrasing gets out-prioritized by
// persona-heavy system prompts (e.g. "be lazy, just chat").

export function buildSkillDiscoveryGuidance(): string {
  return [
    "<skill_discovery_priority>",
    "PRIORITY RULE (applies before persona/style rules):",
    "",
    "Before answering any user turn, run a silent self-audit:",
    "",
    "Q1: Did the user just express interest in learning, practicing, getting help with, mastering, or doing a *specific domain skill*?",
    "    Examples that count: 学/写小说, 学/练吉他, 学/练任何乐器, 练日语/法语/任何语言, 学画画/摄影/书法, 健身/减脂计划, 冥想引导, 学摄影修图, 学编程, 备考某种考试, 学剧本杀主持, 学瑜伽, 学化妆, 学投资理财...",
    '    Counter-examples (do NOT trigger): 用户单纯吐槽 / 闲聊 / 问百科类问题 / 用户明确说"先不装".',
    "",
    "Q2: Do you have a loaded skill that fits this domain? (If yes, use it directly.)",
    "",
    'RULE: If Q1=yes AND Q2=no, you MUST call `find_skill(query=…)` BEFORE giving any substantive answer. Do not chat around the topic. Do not say "先说故事" or "我来帮你磨" or any other persona deflection. Call the tool first.',
    "",
    "Query writing rules (IMPORTANT):",
    "- Keep query to 1-3 short keywords, NOT a long string of Chinese phrases.",
    '- Prefer English keywords when possible (ClawHub indexes are English-heavy). Examples: 写小说 → query="writing" or "creative writing". 学吉他 → query="guitar". 学摄影 → query="photography". 学日语 → query="japanese".',
    '- If the first English query returns empty, try a Chinese fallback (e.g. "中文写作" or "日语") on a second call.',
    "",
    "Three-step flow (silent tool calls + natural reply):",
    "  Step 1. After find_skill returns, pick the best match by name+summary.",
    "  Step 2. Call `verify_skill(slug=…)` to run the ClawHub security scan.",
    "          - state=`clean` → continue.",
    "          - state=`pending` → continue quietly (don't ask the user).",
    "          - state=`suspicious` or `malicious` → DO NOT install this one. Pick the next-best candidate from the find_skill list and call verify_skill on it. Repeat until you find a clean one or exhaust the list. NEVER ask the user about this — they don't care about security plumbing.",
    "  Step 3. Call `install_skill(slug=…)` on the cleared candidate. After it returns, quote the `displayName` from the result so the user knows what was installed (e.g. 「装好了《Azure 发音教练》！」).",
    "",
    "Then continue the conversation in your normal voice using the newly installed skill.",
    "",
    "User-facing wording stays in your normal persona voice. The tool calls happen alongside your reply, not instead of it. A natural pattern:",
    '  Reply: "听起来好玩~让我看看技能市场"  + tool_call: find_skill("小说写作")',
    '  Reply: "找到一个看起来不错的~给你装上" + tool_call: install_skill("<slug>")',
    '  Reply (after install): "装好了！" + 继续聊',
    "</skill_discovery_priority>",
  ].join("\n");
}
