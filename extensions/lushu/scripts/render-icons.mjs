#!/usr/bin/env node
// render-icons.mjs — 输出 transit/flight 图标的 CSS mask-image 定义
//
// 用法:
//   node render-icons.mjs
//     输出整段 <style>...</style>，含 .transit-icon / .flight-icon 基础尺寸
//     和 .icon-walk / .icon-car / .icon-train / .icon-flight 的 mask-image 定义。
//     Agent 把整段拷到 <head> 内 </style> 之后即可（与 render-map.mjs 同位置）。
//
// 环境变量:
//   API_BASE_URL  — 图标静态资源的对外 URL 前缀，默认 https://assist.ucblab.com
//                   server .env 同名变量是单一真相
//
// 设计要点:
//   - mask-image 引用对外 URL，不再 inline base64
//     原因：长 base64（>4000 字符）会让 LLM 重写时字符级幻觉，整张图坏掉
//   - 实际图标文件由 sync-icons.sh 同步到 server static/lushu-icons/
//   - background-color: currentColor → 颜色跟主题（.transit-next 上下文继承）
//   - 单色 mask 工作原理：SVG 的 alpha（不论是 fill 还是 stroke）即遮罩形状
//
// HTML 用法:
//   <i class="transit-icon icon-car"></i>          ← 16px，给 transit-next 用
//   <i class="flight-icon icon-flight"></i>         ← 22px，给 flight-card 用

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, "..", "assets", "icons");

const ICON_KEYS = ["walk", "car", "train", "flight"];
const BASE_URL = (process.env.API_BASE_URL || "https://assist.ucblab.com").replace(/\/+$/, "");

function renderIcons() {
  const lines = [];
  lines.push(
    "<!-- 图标 setup (lushu/scripts/render-icons.mjs) — transit-icon / flight-icon 系列 -->",
  );
  lines.push("<style>");
  lines.push(
    "/* 基础尺寸：transit-next 行内用 16px，flight-card 路线用 22px。两者都靠 currentColor 跟主题。 */",
  );
  lines.push(".transit-icon, .flight-icon {");
  lines.push("    display: inline-block;");
  lines.push(
    "    flex-shrink: 0;                /* 防止 .transit-next 是 flex 时把空 <i> 压到 0px */",
  );
  lines.push("    background-color: currentColor;");
  lines.push("    -webkit-mask-size: contain;       mask-size: contain;");
  lines.push("    -webkit-mask-repeat: no-repeat;   mask-repeat: no-repeat;");
  lines.push("    -webkit-mask-position: center;    mask-position: center;");
  lines.push("}");
  lines.push(".transit-icon { width: 16px; height: 16px; vertical-align: -3px; }");
  lines.push(".flight-icon  { width: 22px; height: 22px; vertical-align: middle; }");
  lines.push("");

  for (const key of ICON_KEYS) {
    // 仍校验源文件存在（防止 sync-icons.sh 漏配）
    const file = path.join(ASSETS_DIR, `${key}.svg`);
    if (!fs.existsSync(file)) {
      console.error(`⚠️  缺源图标: ${file}`);
      continue;
    }
    const url = `url("${BASE_URL}/static/lushu-icons/${key}.svg")`;
    lines.push(`.icon-${key} { -webkit-mask-image: ${url}; mask-image: ${url}; }`);
  }

  lines.push("</style>");
  return lines.join("\n");
}

// ─── 入口 ───
console.log(renderIcons());
