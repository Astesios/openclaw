// 父 agent 调 get_lushu_spawn_prompt 时,plugin 用这个模块拼 subagent task prompt 字符串。
// 等价原 SUBAGENT.md + 当前会话 spawn 数据(图片/flyai/output path 等)。

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// source mode: extensions/lushu/src/  → ../assets
// dist mode:   dist/extensions/lushu/ → ./assets
const ASSETS_DIR_CANDIDATES = [path.resolve(here, "..", "assets"), path.resolve(here, "assets")];
export const ASSETS_DIR =
  ASSETS_DIR_CANDIDATES.find((candidate) => existsSync(candidate)) ?? ASSETS_DIR_CANDIDATES[0];

const REFERENCES_DIR = path.join(ASSETS_DIR, "references");

export type StyleKey = "minimalist" | "elegant" | "scrapbook" | "dynamic" | "imperial";

export type SpawnPromptInput = {
  outputPath: string;
  style: StyleKey;
  planMdPath: string;
  imagesJsonPath?: string;
  flyaiSummary?: string;
  spaceId?: string;
  stopsByDay?: Array<{ day: number; stops: Array<{ name: string; lnglat: [number, number] }> }>;
};

function refPath(name: string): string {
  return path.join(REFERENCES_DIR, name);
}

export function listReferencePaths(style: StyleKey): {
  essentials: string;
  exampleSkeleton: string;
  exampleDay: string;
  celiaBridge: string;
  styleGuide: string;
} {
  return {
    essentials: refPath("essentials.md"),
    exampleSkeleton: refPath("example-skeleton.html"),
    exampleDay: refPath("example-day.html"),
    celiaBridge: refPath("celia-bridge.md"),
    styleGuide: refPath(`style-${style}.md`),
  };
}

export function buildSpawnTaskPrompt(input: SpawnPromptInput): string {
  const refs = listReferencePaths(input.style);
  const stopsBlock = input.stopsByDay
    ? `\n## 每 day stops 数据(给 render_map_block 用)\n\n\`\`\`json\n${JSON.stringify(input.stopsByDay, null, 2)}\n\`\`\`\n`
    : "";
  const flyaiBlock = input.flyaiSummary
    ? `\n## FlyAI 数据(已 plugin 内归一化,直接用)\n\n${input.flyaiSummary}\n`
    : "";
  const imagesBlock = input.imagesJsonPath
    ? `\n## 图片 URL 映射\n\nfetch_images 已写到: ${input.imagesJsonPath}\n请 read 该 JSON,把每景点 \`recommended.url\` 作为 \`<img src>\`(在线 URL,**不要**改成本地路径)。\n`
    : "";
  const spaceBlock = input.spaceId
    ? `\n## 空间上下文\nspace_id: ${input.spaceId}\n如需要,自行 read 该空间的 \`space.json\` 和 \`clipped/\` 拿额外素材。\n`
    : "";

  return [
    `生成一个交互式路书 HTML,输出到: ${input.outputPath}`,
    "",
    "## 先 read 以下文件,严格按其中规范实现",
    "",
    `- ${refs.essentials} — sticky tab / transit-next / FlyAI 卡片三段必读规范`,
    `- ${refs.exampleSkeleton} — 完整 HTML 外层骨架`,
    `- ${refs.exampleDay} — day section 内部结构`,
    `- ${refs.styleGuide} — 视觉规范(${input.style} 风格)`,
    `- ${refs.celiaBridge} — Bridge 实现照抄不要自己编`,
    `- ${input.planMdPath} — 原始行程规划(read 全文,不要只看概要,否则会硬编 1-2 句空洞描述)`,
    "",
    "## 🚨 修复阶段铁律",
    "",
    "收到 `validate_lushu` 返回 `exit: 1`(FAIL)或 `exit: 2`(WARN)时:",
    "",
    "❌ **MUST NOT** 用 `write` 重写整个 HTML。重写整个 HTML = 失败信号,不是修复手段。",
    "❌ **MUST NOT** 用 `ls -R` / `find` 探索性 exec。validate_lushu 返回的 fails / warns 数组已经告诉你哪个 check 失败。",
    "❌ **MUST NOT** 用 Bash exec 调原 .mjs / .sh — 必须走 plugin tool。",
    "",
    "✅ **MUST** 优先用修复 tool(`render_map_block({mode:'fix-head'})` / `render_map_block({mode:'insert-transit'})`),其次针对性 Edit 一行/一段。",
    "✅ **MUST** 修一次后立即重调 `validate_lushu`,不要批量改完再验。",
    "✅ **MUST** 累计 3 次仍未 PASS → 停下汇报父 Agent,不要继续硬修。",
    "",
    "## 生成 HTML(用 plugin tool,不要手写 JS / SVG / 也不要 exec)",
    "",
    "| 用途 | tool 调用 | 粘到哪里 |",
    "|---|---|---|",
    "| 地图 setup | `render_map_block({ mode:'head', style:'<风格>' })` → 取 details.html | `</style>` 后、`</head>` 前 |",
    "| 每 day 地图块 | `render_map_block({ mode:'day', day:N, stops:[...], style })` → 取 details.html | 对应 day-section 内 |",
    "| 图标 mask CSS | `render_icons()` → 取 details.html | render_map_block head 输出之后 |",
    "| 修头块错位 | `render_map_block({ mode:'fix-head', file:'<html-path>' })` | validate FAIL check 8 时用 |",
    "| 补 transit-next | `render_map_block({ mode:'insert-transit', file, day, afterStop, transport, duration?, distance?, nextStop? })` | validate WARN 时用,**幂等** |",
    "",
    "**性能**:把 `render_map_block({mode:'head'})` 和 `render_icons()` 放同一个 tool_use batch(并发),省一轮 LLM 思考。",
    "",
    "## 🚨 高德 key 已 hardcode 在 tool 输出里(不是占位符)",
    "",
    "`render_map_block({mode:'head'})` 输出已含真实高德 key 和 securityJsCode,地图能直接渲染。",
    "- ❌ **MUST NOT** 自己再写 `<script src='https://webapi.amap.com/maps?v=2.0&key=...'>` — head 段已经引入 SDK,重复引入 conflict",
    "- ❌ **MUST NOT** 在汇报父 Agent 时说「地图 key 待用户配置」「需要替换 YOUR_AMAP_KEY」之类 — 这是 LLM 训练数据里高德文档套话的幻觉",
    "- ✅ 验证 PASS 后直接汇报「路书 HTML 已生成在 <path>」,不附加任何 key 提示",
    "",
    "## 禁止改 tool 输出",
    "",
    "- `createLushuMap` 函数命名不可改成 `initMap` 等",
    "- leading `<!-- WARNING: ... -->` 注释格式不可动",
    "- 整段必须粘到 `</style>` 之后、`</head>` 之前",
    "",
    "## HTML 总要求",
    "",
    "- 单文件(CSS/JS 内联) / 移动端优先(viewport, 375px 完美) / 图片 lazy + onerror / 中英文混排",
    "",
    "## write 前自检清单",
    "",
    "- transit-next:相邻 timeline-item 不同地点 → 加 `<div class='transit-next'>`",
    "- 价格:query_flyai 已归一化,直接用。HTML 里**绝不能出现** `¥xx` / `¥XX` / `约 X-X 元` 占位符",
    "- 链接:全部走 `onclick=\"CeliaBridge.invoke('surface.open', { url: 'xxx' })\"`,**不用** `<a target='_blank'>`",
    "- 图片:全部 `https://...` 在线 URL,**不能** `images/xxx.jpg`",
    "- 图标:用 `<i class='transit-icon icon-X'></i>`(walk/car/train/flight),**不能用 emoji**",
    "",
    "## 写完后",
    "",
    "1. write HTML 文件",
    "2. 调 `validate_lushu({path})`",
    "3. EXIT 0 才告知父 Agent 完成,**不附加 key 提示**;EXIT 1/2 先按上方修复决策修补",
    spaceBlock,
    imagesBlock,
    flyaiBlock,
    stopsBlock,
  ].join("\n");
}
