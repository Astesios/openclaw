#!/usr/bin/env node
// render-map.mjs — 生成路书地图相关 HTML（替代 Agent 自己写 JS，避免命名漂移）
//
// 用法:
//   node render-map.mjs --mode head [--style minimalist|elegant|scrapbook|dynamic|imperial]
//     输出 <head> 段：高德 SDK 引入 + 全局 helper（enableMapFocus / createLushuMap） + CSS
//     Agent 把整段拷到 <head> 末尾即可
//
//   node render-map.mjs --mode day --day N --stops <JSON> [--style ...]
//     输出某 day 的 HTML 块（map-wrap container + script 调 createLushuMap）
//     Agent 把整段拷到 day-section 内即可
//
//   node render-map.mjs --mode fix-head --file <path>
//     就地修复：把误粘到 body 末尾的 head 块剪贴回 </head> 之前。
//     用于 validate-lushu.sh check 8 失败后的快速恢复（避免 Agent 全文重写）。
//     依赖 head 块里的注释标记 "<!-- 路书地图 setup (lushu/scripts/render-map.mjs) -->"
//
//   node render-map.mjs --mode insert-transit --file <path>
//                       --day N --after-stop M
//                       --transport "驾车|步行|高铁|航班"
//                       [--duration "30min"] [--distance "10km"] [--next-stop "孤独图书馆"]
//     就地插入：在 day-N 内第 M 个 timeline-item 的 timeline-content 末尾插入一个
//     标准 transit-next 块。用于 validate-lushu.sh EXIT 2（WARN: transit-next 缺失）的快速修复，
//     避免 Agent 用 Edit/write 自由发挥导致全文重写。
//     幂等：如果该 timeline-item 内已存在 transit-next，跳过不重复插入。
//
// 关键：Agent 不需要自己写任何 JS。所有命名 / 配色 / 关键值都由本脚本保证一致。

import fs from "fs";

// ─── 解析 CLI 参数 ───
const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    opts[args[i].slice(2)] = args[i + 1];
    i++;
  }
}

// ─── 风格配色 ───
const styleColors = {
  minimalist: { stroke: "#111111", mapStyle: "whitesmoke" },
  elegant: { stroke: "#222222", mapStyle: "whitesmoke" },
  scrapbook: { stroke: "#8B6914", mapStyle: "fresh" },
  dynamic: { stroke: "#111111", mapStyle: "grey" },
  imperial: { stroke: "#D4AF37", mapStyle: "whitesmoke" },
};
const style = opts.style || "minimalist";
const colors = styleColors[style] || styleColors.minimalist;

// ─── head 段（SDK + 全局 helper + CSS） ───
function renderHead() {
  return `<!-- WARNING: insert this block AFTER </style>, NOT inside <style>. -->
<!-- WARNING: keep these as HTML comments. CSS comment form will break the page. -->
<!-- 路书地图 setup (lushu/scripts/render-map.mjs) -->
<script>
window._AMapSecurityConfig = { securityJsCode: 'ecbd4b94027fe435e5dad698c8317d4e' };

window.enableMapFocus = function(map, wrapEl, focusBtn) {
    function setGesturesEnabled(on) {
        map.setStatus({ zoomEnable: on, dragEnable: on, doubleClickZoom: on,
                        scrollWheel: on, jogEnable: on, pinchToZoom: on });
    }
    setGesturesEnabled(false);
    var isFocused = false;
    function setLabel(t) { var el = focusBtn.querySelector('.btn-label'); if (el) el.textContent = t; }
    function focus()   { if (!isFocused) { isFocused = true;  setGesturesEnabled(true);
        focusBtn.classList.add('active'); wrapEl.classList.add('active'); setLabel('已激活'); } }
    function unfocus() { if (isFocused)  { isFocused = false; setGesturesEnabled(false);
        focusBtn.classList.remove('active'); wrapEl.classList.remove('active'); setLabel('激活地图'); } }
    focusBtn.addEventListener('click', function(e) { e.stopPropagation(); if (isFocused) unfocus(); else focus(); });
    document.addEventListener('touchstart', function(e) {
        if (isFocused && !wrapEl.contains(e.target)) unfocus();
    }, { passive: true });
    document.addEventListener('click', function(e) {
        if (isFocused && !wrapEl.contains(e.target)) unfocus();
    });
};

window.createLushuMap = function(id, stops, wrapId) {
    var map = new AMap.Map(id, {
        zoom: 12, center: stops[0].lnglat,
        mapStyle: 'amap://styles/${colors.mapStyle}',
        showTraffic: false
    });
    var wrap = document.getElementById(wrapId);
    window.enableMapFocus(map, wrap, wrap.querySelector('.map-focus-btn'));

    var savedPolyline = null;
    function fitMapView(p) {
        if (p) savedPolyline = p;
        setTimeout(function() {
            if (savedPolyline) map.setFitView([savedPolyline], false, [60, 60, 60, 60], 16);
            else map.setFitView(null, false, [60, 60, 60, 60], 16);
        }, 300);
    }

    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(function(entries) {
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].contentRect.width > 0) { map.resize(); fitMapView(); }
            }
        }).observe(wrap);
    }

    stops.forEach(function(s) {
        new AMap.Marker({
            position: s.lnglat,
            content: '<div style="width:10px;height:10px;background:${colors.stroke};' +
                     'border-radius:50%;border:2px solid #fff;' +
                     'box-shadow:0 1px 4px rgba(0,0,0,0.25);"></div>',
            offset: new AMap.Pixel(-5, -5),
            label: { content: s.name, direction: 'top' },
            map: map
        });
    });

    if (stops.length < 2) { fitMapView(); return; }

    AMap.plugin('AMap.Driving', function() {
        var origin = stops[0].lnglat;
        var destination = stops[stops.length - 1].lnglat;
        var waypoints = stops.slice(1, -1).map(function(s) { return s.lnglat; });

        function trySearch(policy, onDone) {
            var driving = new AMap.Driving({
                policy: policy, hideMarkers: true, autoFitView: false
            });
            driving.search(origin, destination, { waypoints: waypoints }, function(status, result) {
                console.log('[lushu map ' + id + '] policy=' + policy + ' status=' + status);
                if (status === 'complete' && result.routes && result.routes.length) onDone(true, result);
                else onDone(false, null);
            });
        }

        trySearch(AMap.DrivingPolicy.LEAST_TIME, function(ok, result) {
            if (ok) { drawRoute(result); return; }
            trySearch(AMap.DrivingPolicy.LEAST_DISTANCE, function(ok2, r2) {
                if (ok2) drawRoute(r2); else drawFallback();
            });
        });

        function drawRoute(result) {
            var path = result.routes[0].steps.reduce(function(a, s) { return a.concat(s.path); }, []);
            var polyline = new AMap.Polyline({
                path: path, strokeColor: '${colors.stroke}', strokeWeight: 4,
                strokeOpacity: 0.8, lineJoin: 'round', map: map
            });
            fitMapView(polyline);
        }

        function drawFallback() {
            var fb = new AMap.Polyline({
                path: stops.map(function(s) { return s.lnglat; }),
                strokeColor: '${colors.stroke}', strokeWeight: 3,
                strokeOpacity: 0.5, strokeStyle: 'dashed', map: map
            });
            fitMapView(fb);
        }
    });
};
</script>
<script src="https://webapi.amap.com/maps?v=2.0&key=31293b9b13c039780946f4a9a2e7351f"></script>
<style>
.map-wrap { position: relative; pointer-events: none; touch-action: pan-y; }
.map-wrap.active { pointer-events: auto; touch-action: none; }
.map-container { height: 240px; border-radius: 12px; }
.map-focus-btn {
    display: flex; align-items: center; gap: 5px;
    pointer-events: auto;
    position: absolute; right: 12px; bottom: 12px;
    background: rgba(0, 0, 0, 0.08);
    border: none;
    border-radius: 20px;
    padding: 5px 12px 5px 8px;
    font-size: 12px; font-weight: 500;
    color: #1A1A1A;
    cursor: pointer;
    user-select: none;
    transition: background 0.2s ease, box-shadow 0.2s ease;
    z-index: 10;
}
.map-focus-btn.active { background: rgba(255,255,255,0.95); box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
.map-focus-icon {
    display: inline-block; flex-shrink: 0;
    width: 18px; height: 18px;
    background-color: rgba(0,0,0,0.45);
    -webkit-mask-image: url("https://assist.ucblab.com/static/lushu-icons/touch.svg");
    mask-image: url("https://assist.ucblab.com/static/lushu-icons/touch.svg");
    -webkit-mask-size: contain; mask-size: contain;
    -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
    -webkit-mask-position: center; mask-position: center;
    transition: background-color 0.15s ease;
}
.map-focus-btn.active .map-focus-icon { background-color: #1A1A1A; }
.amap-marker-label { border: none !important; background: rgba(255,255,255,0.88) !important; box-shadow: 0 1px 3px rgba(0,0,0,0.12) !important; padding: 2px 6px !important; border-radius: 4px !important; font-size: 11px !important; }
</style>
`;
}

// ─── fix-head 模式：把误粘到 body 的 head 块剪贴回 </head> 前 ───
function fixHead(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`文件不存在: ${filePath}`);
    process.exit(2);
  }
  const html = fs.readFileSync(filePath, "utf-8");

  // 匹配整段 head 块：可选 leading WARNING 注释 + 主标记注释 + 中间内容 + 第一个 </style>
  // 主标记注释是脚本输出的唯一指纹，wrap 内 CSS 没有嵌套 </style>，所以第一个 </style> 即闭合标签
  const blockRegex =
    /(?:[ \t]*<!--\s*WARNING:[\s\S]*?-->\s*)*[ \t]*<!--\s*路书地图 setup \(lushu\/scripts\/render-map\.mjs\)\s*-->[\s\S]*?<\/style>/;
  const match = blockRegex.exec(html);

  if (!match) {
    console.error('找不到 head 块标记 "<!-- 路书地图 setup (lushu/scripts/render-map.mjs) -->"');
    console.error("HTML 可能不是 render-map.mjs 生成的，或 Agent 改动了注释。请检查或重新生成。");
    process.exit(2);
  }

  const blockStart = match.index;
  const blockEnd = match.index + match[0].length;
  const headBlock = html.slice(blockStart, blockEnd).trim();

  const headEndIdx = html.indexOf("</head>");
  if (headEndIdx < 0) {
    console.error("找不到 </head> — HTML 结构异常");
    process.exit(2);
  }

  if (blockStart < headEndIdx) {
    console.log("✅ head 块已在 <head> 内，无需修复");
    process.exit(0);
  }

  const oldLine = html.slice(0, blockStart).split("\n").length;
  const cleaned = html.slice(0, blockStart) + html.slice(blockEnd);
  const newHeadEndIdx = cleaned.indexOf("</head>");
  if (newHeadEndIdx < 0) {
    console.error("清理后找不到 </head> — 内部错误");
    process.exit(2);
  }

  const fixed = cleaned.slice(0, newHeadEndIdx) + headBlock + "\n" + cleaned.slice(newHeadEndIdx);
  fs.writeFileSync(filePath, fixed, "utf-8");

  const newLine = fixed.slice(0, newHeadEndIdx).split("\n").length;
  console.log(`✅ head 块已从 line ${oldLine} 剪贴到 </head> 前 (现在 line ~${newLine})`);
  console.log(`   建议再跑一次 validate-lushu.sh 确认 check 8 PASS。`);
}

// ─── insert-transit 模式：在指定 day 的指定 timeline-item 后插入 transit-next ───

function genTransitHtml(transport, duration, distance, nextStop) {
  // 交通方式 → icon class（4 种：walk / car / train / flight，库外降级为 icon-car）
  const norm = (transport || "").toLowerCase();
  let iconClass = "icon-car";
  if (norm.includes("步行") || norm.includes("walk")) iconClass = "icon-walk";
  else if (norm.includes("航班") || norm.includes("飞机") || norm.includes("flight"))
    iconClass = "icon-flight";
  else if (norm.includes("高铁") || norm.includes("火车") || norm.includes("train"))
    iconClass = "icon-train";
  else if (norm.includes("驾车") || norm.includes("专车") || norm.includes("car"))
    iconClass = "icon-car";

  // 文案：transport [distance] [· duration]
  let info = transport;
  if (distance) info += ` ${distance}`;
  if (duration) info += ` · ${duration}`;

  let html = `<div class="transit-next">\n  <i class="transit-icon ${iconClass}"></i>\n  <span class="transit-info">${info}</span>`;
  if (nextStop) html += `\n  <span class="transit-info-next">→ ${nextStop}</span>`;
  html += `\n  <span class="transit-arrow">›</span>\n</div>`;
  return html;
}

function insertTransit(filePath, dayN, afterStop, transport, duration, distance, nextStop) {
  if (!fs.existsSync(filePath)) {
    console.error(`文件不存在: ${filePath}`);
    process.exit(2);
  }
  if (!dayN || !afterStop || !transport) {
    console.error("--day / --after-stop / --transport 都是必填");
    process.exit(2);
  }

  const html = fs.readFileSync(filePath, "utf-8");

  // 1. 找 day-N 的 section/div 起始（兼容 <section> 和 <div>）
  const dayRe = new RegExp(`<(section|div)[^>]*\\bid=["']day-?${dayN}["'][^>]*>`);
  const dayMatch = dayRe.exec(html);
  if (!dayMatch) {
    console.error(`找不到 id="day-${dayN}" 或 id="day${dayN}"`);
    process.exit(2);
  }
  const dayStart = dayMatch.index;

  // 2. 在 day-N 内顺序找第 afterStop 个 timeline-item
  const itemRe = /<div[^>]*\bclass=["'][^"']*\btimeline-item\b[^"']*["'][^>]*>/g;
  itemRe.lastIndex = dayStart;
  let itemStart = -1;
  let foundCount = 0;
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    foundCount++;
    if (foundCount === Number(afterStop)) {
      itemStart = m.index;
      break;
    }
    // 防穿越：检查是否已经进入下一个 day section
    const slice = html.slice(dayStart, m.index);
    if (/<(?:section|div)[^>]*\bid=["']day-?\d+["']/.test(slice.slice(dayMatch[0].length))) {
      // m.index 已经在 day-N 之外
      break;
    }
  }
  if (itemStart === -1) {
    console.error(
      `day-${dayN} 内找不到第 ${afterStop} 个 timeline-item（仅找到 ${foundCount} 个）`,
    );
    process.exit(2);
  }

  // 3. 扫描 div 嵌套深度找 timeline-item 的关闭 </div>
  const tagRe = /<\/?div\b[^>]*>/g;
  tagRe.lastIndex = itemStart;
  let depth = 0;
  let itemEnd = -1;
  let mm;
  while ((mm = tagRe.exec(html)) !== null) {
    if (mm[0].startsWith("</")) {
      depth--;
      if (depth === 0) {
        itemEnd = mm.index;
        break;
      }
    } else {
      depth++;
    }
  }
  if (itemEnd === -1) {
    console.error(`找不到第 ${afterStop} 个 timeline-item 的闭合 </div>`);
    process.exit(2);
  }

  // 4. 幂等检查：该 timeline-item 内已有 transit-next 则跳过
  const itemSlice = html.slice(itemStart, itemEnd);
  if (/class=["'][^"']*\btransit-next\b/.test(itemSlice)) {
    console.log(`✅ day-${dayN} 第 ${afterStop} 个 timeline-item 已有 transit-next，跳过插入`);
    process.exit(0);
  }

  // 5. 找 timeline-content 的关闭 </div>（即 itemSlice 内最后一个 </div>，因为 timeline-item 关闭还未到）
  const contentCloseIdx = itemSlice.lastIndexOf("</div>");
  if (contentCloseIdx === -1) {
    console.error(`timeline-item 内没找到嵌套 </div>，HTML 结构异常`);
    process.exit(2);
  }
  const closeAbsIdx = itemStart + contentCloseIdx;

  // 6. 算缩进：取 timeline-content 关闭那一行的行首 + leading 空格
  const lineStart = html.lastIndexOf("\n", closeAbsIdx) + 1;
  const indentRaw = html.slice(lineStart, closeAbsIdx).match(/^[ \t]*/)[0];
  const childIndent = indentRaw + "    ";

  // 7. 生成 transit HTML 并加缩进；插入到 lineStart（行首）之前，避免与已有缩进重复
  const transitHtml = genTransitHtml(transport, duration, distance, nextStop);
  const indented = transitHtml
    .split("\n")
    .map((l) => (l ? childIndent + l : l))
    .join("\n");

  const fixed = html.slice(0, lineStart) + indented + "\n" + html.slice(lineStart);
  fs.writeFileSync(filePath, fixed, "utf-8");

  const insertLine = html.slice(0, lineStart).split("\n").length;
  console.log(
    `✅ 在 day-${dayN} 第 ${afterStop} 个 timeline-item 末尾插入 transit-next（line ~${insertLine}）`,
  );
  console.log(
    `   交通方式: ${transport}${distance ? " / " + distance : ""}${duration ? " / " + duration : ""}${nextStop ? " → " + nextStop : ""}`,
  );
  console.log(`   建议再跑一次 validate-lushu.sh 确认 WARN 消除。`);
}

// ─── day 块（map-wrap + script 调 createLushuMap） ───
function renderDay(day, stops) {
  if (!Array.isArray(stops) || stops.length === 0) {
    throw new Error("stops 必须是非空数组");
  }
  return `<div class="map-wrap" id="map-wrap-day${day}">
    <div id="map-day${day}" class="map-container"></div>
    <button class="map-focus-btn" type="button"><i class="map-focus-icon"></i><span class="btn-label">激活地图</span></button>
</div>
<script>
window.createLushuMap('map-day${day}', ${JSON.stringify(stops, null, 2)}, 'map-wrap-day${day}');
</script>
`;
}

// ─── 主流程 ───
const mode = opts.mode;

if (mode === "head") {
  process.stdout.write(renderHead());
} else if (mode === "fix-head") {
  if (!opts.file) {
    console.error("--file <path> 必须");
    process.exit(2);
  }
  fixHead(opts.file);
} else if (mode === "insert-transit") {
  insertTransit(
    opts.file,
    opts.day,
    opts["after-stop"],
    opts.transport,
    opts.duration,
    opts.distance,
    opts["next-stop"],
  );
} else if (mode === "day") {
  if (!opts.day) {
    console.error("--day 必须");
    process.exit(2);
  }
  let stops;
  if (opts["stops-file"]) {
    stops = JSON.parse(fs.readFileSync(opts["stops-file"], "utf-8"));
  } else if (opts.stops) {
    try {
      stops = JSON.parse(opts.stops);
    } catch (e) {
      console.error("--stops JSON 解析失败:", e.message);
      process.exit(2);
    }
  } else {
    console.error("--stops <JSON> 或 --stops-file <path> 必须");
    process.exit(2);
  }
  try {
    process.stdout.write(renderDay(opts.day, stops));
  } catch (e) {
    console.error("错误:", e.message);
    process.exit(2);
  }
} else {
  console.error(`用法:
  node render-map.mjs --mode head [--style minimalist|elegant|scrapbook|dynamic|imperial]
  node render-map.mjs --mode day --day N --stops '<JSON>' [--style ...]
  node render-map.mjs --mode day --day N --stops-file path.json [--style ...]
  node render-map.mjs --mode fix-head --file <html-path>
    （把误粘到 body 末尾的 head 块剪贴回 </head> 之前；
     用于 validate-lushu.sh check 8 失败时快速恢复）
  node render-map.mjs --mode insert-transit --file <html-path>
                      --day N --after-stop M
                      --transport "驾车|步行|高铁|航班"
                      [--duration "30min"] [--distance "10km"] [--next-stop "孤独图书馆"]
    （在 day-N 第 M 个 timeline-item 末尾插入 transit-next；
     用于 validate-lushu.sh EXIT 2（WARN）时快速修复，幂等）

stops JSON 格式:
  [{ "name": "站点名", "lnglat": [经度, 纬度] }, ...]
`);
  process.exit(2);
}
