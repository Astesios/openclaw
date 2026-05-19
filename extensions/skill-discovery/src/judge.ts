// Capability-request judge (rule-based v1).
//
// Decides — independently of the main conversational model — whether the
// user's latest message expresses a *vertical capability request* that
// warrants going to ClawHub. Returns the English keyword to search with.
//
// Rule-based on purpose:
//   - Fast (no extra LLM call per turn)
//   - Deterministic (won't be over-ridden by the agent's persona)
//   - Cheap (no token cost)
//   - V2 can layer an LLM tie-breaker if recall isn't enough.

export type JudgeResult = {
  trigger: boolean;
  query?: string; // English keyword for ClawHub
  domainLabel?: string; // Chinese label for UI/log ("写作", "吉他")
  reason?: string;
};

// Intent verbs / phrases that signal "want to learn / practice / get help".
// Broader on purpose — Recall > Precision: a wrong-positive only costs one
// silent ClawHub search; a miss kills the demo flow.
const LEARN_PATTERNS: RegExp[] = [
  /想\s*(学|练|做|写|画|考|减|健身|备考|搞|试|聊|读|看|拍|弹|跳|唱|讲|背)/,
  /(学|练|做|写|画|搞|读)一(下|个|点|本|首)/,
  /(教|带)我\s*(学|练|做|写|画|入门|做|玩|搞|读)?/,
  /帮我\s*(练|学|写|做|画|找|准备|搞|读|看|背|刷|整|理)/,
  /(入门|开始|从零|开头|起步|起头)\s*(学|练|做|搞|玩)?/,
  /我要\s*(考|学|练|备考|减肥|健身|搞|做|写|读)/,
  /想要\s*(学|考|练|做|写|读|搞|入门)/,
  /怎么\s*(学|练|准备|备考|写|做|开始|入门|搞|读)/,
  /(系统|认真|深入|从头|彻底)\s*(学|了解|研究)/,
  /(打|搭|建立|建)\s*(基础|框架|体系)/,
  /(摸索|研究|钻研|琢磨|拓展)\s*一?\s*(下|点)?/,
  /(上手|提升|突破|进阶|强化|训练)/,
  /有没有\s*(技能|能力|skill|教程|课)/,
  /能不能\s*(教|带|帮|陪)我/,
  // English helpers
  /\b(learn|practice|study|prepare for|teach me|help me|get started|pick up|brush up)\b/i,
];

// Domain matchers: (regex → English keyword for ClawHub, Chinese label).
// EVERY entry below has been verified against the live ClawHub API as of
// 2026-05-14 — searching the keyword returns at least one real installable
// skill. Don't add a domain without first running `openclaw skills search
// <keyword>` to confirm the marketplace actually has something to install.
const DOMAINS: Array<{ rx: RegExp; query: string; label: string }> = [
  // ── 语言（实测有 skill）──
  { rx: /雅思|IELTS/i, query: "ielts", label: "雅思" },
  { rx: /日语|日文/, query: "japanese", label: "日语" },
  { rx: /英语|英文/, query: "english", label: "英语" },
  { rx: /翻译|translate|translation/i, query: "translation", label: "翻译" },

  // ── 写作（实测有 skill）──
  { rx: /论文|学术|essay|paper|thesis/i, query: "academic-writing", label: "学术写作" },
  { rx: /小说|创意写作|短篇|散文|写作|博客|blog/i, query: "writing", label: "写作" },

  // ── 编程 / 开发流程（实测有 skill）──
  { rx: /python/i, query: "python", label: "Python" },
  { rx: /javascript|typescript|\bjs\b|\bts\b/i, query: "javascript", label: "JavaScript" },
  { rx: /前端|frontend|ui\s*设计|界面设计/i, query: "frontend-design", label: "前端设计" },
  { rx: /编程|代码|程序|coding|programming/i, query: "coding", label: "编程" },
  {
    rx: /code\s*review|代码审查|审查代码|review\s*我的代码|改代码|看代码/i,
    query: "code-review",
    label: "代码审查",
  },
  {
    rx: /git\s*commit|提交信息|commit\s*消息|commit\s*message/i,
    query: "git-commit",
    label: "Git commit",
  },
  { rx: /readme|自述文件/i, query: "readme", label: "README" },
  { rx: /pr\s*描述|pull\s*request|PR\s*说明/i, query: "pr-description", label: "PR 描述" },

  // ── 数据 / 办公（实测有 skill）──
  { rx: /excel|表格|spreadsheet|工作簿|xlsx/i, query: "excel", label: "Excel" },

  // ── 网页 / 浏览器（实测有 skill）──
  {
    rx: /爬虫|抓取|网页爬取|scraping|firecrawl|搜集网页|采集网页/i,
    query: "firecrawl",
    label: "网页抓取",
  },
  {
    rx: /浏览器自动化|browser\s*automation|e2e\s*测试|端到端测试|playwright/i,
    query: "playwright",
    label: "浏览器自动化",
  },

  // ── 视觉（实测有 skill）──
  { rx: /摄影|拍照/, query: "photography", label: "摄影" },

  // ── 商业 / 职场（实测有 skill）──
  { rx: /SEO|搜索引擎优化/i, query: "seo", label: "SEO" },
  { rx: /营销|marketing|推广|投放/i, query: "marketing", label: "营销" },

  // ── 记忆 / 长期上下文（实测有 skill）──
  {
    rx: /长期记忆|knowledge\s*base|supermemory|个人知识库|笔记系统/i,
    query: "supermemory",
    label: "长期记忆",
  },
];

// Phrases that should suppress the trigger (user is venting or chatting).
const SUPPRESS_PATTERNS: RegExp[] = [
  /先别\s*装/,
  /不用\s*装/,
  /(暂时|先)\s*(别|不)\s*找/,
  /^\s*(哈哈|呵呵|嗯|啊|哦)/,
];

/**
 * 把 plugin 自己之前注入的 <skill_market_autoaudit>...</skill_market_autoaudit>
 * 块剥掉。否则 judge 会在自己上一回合写进历史的 block 里读到 "japanese"/"english"
 * 等词，无限自循环命中。
 */
function stripAutoauditBlocks(text: string): string {
  return text.replace(/<skill_market_autoaudit\b[\s\S]*?<\/skill_market_autoaudit>/g, "");
}

export function judgeUserMessage(message: string): JudgeResult {
  if (!message) {
    return { trigger: false };
  }
  const cleaned = stripAutoauditBlocks(message).trim();
  if (cleaned.length < 4) {
    return { trigger: false };
  } // too short to be a real ask

  if (SUPPRESS_PATTERNS.some((rx) => rx.test(cleaned))) {
    return { trigger: false, reason: "suppress phrase" };
  }

  const wantsToLearn = LEARN_PATTERNS.some((rx) => rx.test(cleaned));
  if (!wantsToLearn) {
    return { trigger: false, reason: "no learn-intent verb" };
  }

  const domain = DOMAINS.find((d) => d.rx.test(cleaned));
  if (!domain) {
    return { trigger: false, reason: "no recognised domain" };
  }

  return {
    trigger: true,
    query: domain.query,
    domainLabel: domain.label,
    reason: `learn-intent + domain "${domain.label}"`,
  };
}

/** Extract the most recent user message from the agent's message array. */
export function extractLatestUserMessage(messages: unknown[]): string | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (!m || typeof m !== "object") {
      continue;
    }
    if (m.role !== "user") {
      continue;
    }
    const c = m.content;
    if (typeof c === "string") {
      return c;
    }
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
          const t = (part as { text?: string }).text;
          if (typeof t === "string") {
            return t;
          }
        }
      }
    }
  }
  return null;
}
