#!/bin/bash
# validate-lushu.sh — 验证生成的路书.html 是否符合 lushu skill 规范
#
# 用法: validate-lushu.sh <路书.html 路径>
# Exit:
#   0 = 全部 PASS（可告知用户完成）
#   1 = 有 FAIL（必须用 Edit 工具修补，不要告知用户完成）
#   2 = 仅 WARN（transit-next 数量嫌疑，需对照 references/essentials.md「交通过渡提示」section 决策清单核对）
#   3 = 参数 / 文件错误

set -u

if [ $# -lt 1 ]; then
    echo "用法: $0 <路书.html 路径>" >&2
    exit 3
fi

F="$1"

if [ ! -f "$F" ]; then
    echo "❌ 文件不存在: $F" >&2
    exit 3
fi

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

pass() { echo "✅ $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "❌ $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
warn() { echo "⚠️  $1"; WARN_COUNT=$((WARN_COUNT + 1)); }
info() { echo "ℹ️  $1"; }

echo "=== 验证 $F ==="

# ─── 1. transit-next 每日数量 ───
# 输出 INFO，是否漏加由 Agent 对照 references/essentials.md「交通过渡提示」section 决策清单（语义判断，脚本无法准确推断同地点段/跨城段）
# 简单嫌疑判断：item≥2 且 transit-next=0 → 高度漏加嫌疑（极少有连续 2 个 timeline-item 都是同地点）
echo
echo "--- 1. transit-next 每日数量 ---"
for d in 1 2 3 4 5 6 7 8 9 10; do
    cnt=$(awk "/id=\"day-?$d\"/,/id=\"day-?$((d+1))\"/" "$F" | grep -c "transit-next" || true)
    items=$(awk "/id=\"day-?$d\"/,/id=\"day-?$((d+1))\"/" "$F" | grep -c "timeline-item" || true)
    if [ "$items" -gt 0 ]; then
        line="Day$d: transit-next=$cnt / timeline-item=$items"
        if [ "$items" -ge 2 ] && [ "$cnt" -eq 0 ]; then
            warn "$line — 漏加嫌疑（连续 timeline-item 都是同地点的概率很低）"
        else
            info "$line"
        fi
    fi
done

# ─── 2. 地图代码完整 ───
echo
echo "--- 2. 地图代码完整 ---"
CREATEMAP=$(grep -cE "(createMap|createLushuMap)\(" "$F" || true)
DRIVING=$(grep -c "AMap.Driving" "$F" || true)
MAP_DAY_IDS=$(grep -oE 'id="map-day-?[0-9]+"' "$F" | sort -u | wc -l | tr -d ' ')

info "createLushuMap 调用 = $CREATEMAP"
info "AMap.Driving 引用 = $DRIVING"
info "map-dayN 容器 = $MAP_DAY_IDS"

if [ "$MAP_DAY_IDS" -eq 0 ]; then
    info "无地图容器（路书可能是无地图风格）"
elif [ "$CREATEMAP" -eq 0 ]; then
    fail "有 $MAP_DAY_IDS 个 map-day 容器但 createLushuMap=0 — 没用 render-map.mjs 脚本输出（可能写成 initMap 等其他命名，必须照抄脚本输出）"
elif [ "$CREATEMAP" -lt "$MAP_DAY_IDS" ]; then
    warn "createLushuMap=$CREATEMAP 少于容器数=$MAP_DAY_IDS — 部分 day 漏初始化"
else
    pass "createLushuMap=$CREATEMAP 与容器数匹配"
fi

# ─── 3. 顶部遮罩 + IntersectionObserver ───
echo
echo "--- 3. 顶部遮罩 + IntersectionObserver ---"
COVER=$(grep -c '<div class="top-cover' "$F" || true)
IO=$(grep -c "IntersectionObserver" "$F" || true)
[ "$COVER" -ge 1 ] && pass "top-cover 元素 ($COVER)" || fail "缺 <div class=\"top-cover\"> 元素"
[ "$IO" -ge 1 ] && pass "IntersectionObserver ($IO)" || fail "缺 IntersectionObserver（hero 滚出时切换 cover.show）"

# ─── 4. Scroll polling ───
echo
echo "--- 4. Scroll polling ---"
SR=$(grep -c "scrollRestoration" "$F" || true)
ST=$(grep -c "scrollTo(0, 0)" "$F" || true)
if [ "$SR" -ge 1 ] && [ "$ST" -ge 1 ]; then
    pass "scrollRestoration + 800ms scrollTo polling 都在"
else
    fail "缺 scroll polling 修复（scrollRestoration=${SR} scrollTo=${ST}，避免 demo-app-c WebView 自动滚到 hero 底部）"
fi

# ─── 5. 图片在线 URL ───
echo
echo "--- 5. 图片在线 URL ---"
LOCAL_IMG=$(grep -cE 'src="(\./)?images/' "$F" || true)
if [ "$LOCAL_IMG" -eq 0 ]; then
    pass "无本地图片路径"
else
    fail "$LOCAL_IMG 处 images/ 本地路径 — 必须改成在线 URL（fetch-images.mjs 的结果）"
fi

# ─── 6. 地图 JS 关键标识 ───
echo
echo "--- 6. 地图 JS 关键标识 ---"
EMF=$(grep -c "enableMapFocus" "$F" || true)
SFV=$(grep -c "setFitView" "$F" || true)
if [ "$MAP_DAY_IDS" -eq 0 ]; then
    info "无地图容器，跳过"
elif [ "$EMF" -ge 1 ] && [ "$SFV" -ge 1 ] && [ "$DRIVING" -ge 1 ]; then
    pass "enableMapFocus / setFitView / AMap.Driving 都有"
else
    fail "缺地图关键 helper（enableMapFocus=$EMF setFitView=$SFV AMap.Driving=$DRIVING — 必须用 render-map.mjs --mode head 输出，不要手写）"
fi

# ─── 7. head 地图块插入位置（不能塞进 <style> 里） ───
# Bug 模式：Agent 把 render-map.mjs --mode head 输出整段塞进 <style>...</style> 中间，
#   并把 leading 注释从 <!-- --> 改成 /* */ 适配 CSS 上下文。结果整段 <script> 被当 CSS 文本，
#   createLushuMap 永远不被定义，地图渲染失败但 IO/COVER 等检查全部通过（指纹特征）。
echo
echo "--- 7. head 地图块插入位置 ---"
if [ "$MAP_DAY_IDS" -gt 0 ]; then
    # 7a. 致命指纹：leading 注释被改成 CSS 形式
    CSS_MARKER_LINE=$(grep -n "/\* 路书地图 setup" "$F" | head -1 | cut -d: -f1)
    if [ -n "$CSS_MARKER_LINE" ]; then
        fail "head 块 leading 注释从 <!-- --> 改成了 /* */ (line $CSS_MARKER_LINE) — 说明整段被塞进 <style> 内，<script> 全部失效，地图必挂。改回 <!-- 路书地图 setup --> 并把整段移到 </style> 之后"
    fi

    # 7b. 通用检查：createLushuMap 定义不能落在 <style>...</style> 内
    NESTED=$(awk '
        /<style[^>]*>/ { depth++ }
        /<\/style>/ { if (depth > 0) depth-- }
        /window\.createLushuMap[ \t]*=[ \t]*function/ { if (depth > 0) print NR }
    ' "$F")
    if [ -n "$NESTED" ]; then
        fail "createLushuMap 定义嵌套在 <style> 内 (line $NESTED) — <script> 标签在 CSS 上下文中失效，地图必挂"
    fi

    if [ -z "$CSS_MARKER_LINE" ] && [ -z "$NESTED" ]; then
        pass "head 地图块在 <style> 之外"
    fi
fi

# ─── 8. head 块必须在 <head> 内（不在 body 末尾） ───
# Bug 模式：Agent 把 render-map.mjs --mode head 输出粘到 </body> 之前，导致 day-section 内
#   的 createLushuMap('map-dayN', ...) 调用先于 window.createLushuMap = function 定义执行，
#   函数 = undefined，地图全部 silent fail（运行时也不报错，IO/COVER 等通过）。
#   实测案例：青岛国庆之旅 路书 def 在 line 402，调用在 line 256/318/369。
echo
echo "--- 8. head 块在 <head> 内（不能落到 body 末尾） ---"
if [ "$MAP_DAY_IDS" -gt 0 ]; then
    HEAD_END=$(grep -n "</head>" "$F" | head -1 | cut -d: -f1)
    DEF_LINE=$(grep -n "window\.createLushuMap[ \t]*=[ \t]*function" "$F" | head -1 | cut -d: -f1)

    if [ -z "$DEF_LINE" ]; then
        info "未找到 createLushuMap 定义，跳过位置检查（前面的检查应已 FAIL）"
    elif [ -z "$HEAD_END" ]; then
        fail "找不到 </head> — HTML 结构异常"
    elif [ "$DEF_LINE" -gt "$HEAD_END" ]; then
        fail "createLushuMap 定义在 line ${DEF_LINE}，</head> 在 line ${HEAD_END} — head 块整段被粘到 <head> 之外（typically </body> 之前），day-section 内的调用早于函数定义，地图必挂。
   修复方式（一秒搞定，不要全文重写）：
   node ~/.openclaw/workspace/skills/lushu/scripts/render-map.mjs --mode fix-head --file '${F}'
   修复后再跑本脚本验证。"
    else
        pass "createLushuMap 定义 (line ${DEF_LINE}) 在 </head> (line ${HEAD_END}) 之内"
    fi
fi

# ─── 9. 链接走 surface.open（禁止 target="_blank"） ───
# Bug 模式：Agent 看到旧的 example-day.html / 凭训练知识，给 FlyAI 卡片用 <a target="_blank">
#   跳浏览器，破坏沉浸感（半模态用户体验）。规则在 SKILL.md 第 5 步 / essentials.md「FlyAI 数据卡片」/
#   celia-bridge.md 都写过：所有预订/详情链接 MUST 用 onclick="CeliaBridge.invoke('surface.open', { url })"。
echo
echo "--- 9. 链接走 surface.open（禁止 target=\"_blank\"） ---"
BLANK_LINKS=$(grep -cE 'class="(book-btn|detail-btn)"[^>]*target="_blank"|target="_blank"[^>]*class="(book-btn|detail-btn)"' "$F" || true)
if [ "$BLANK_LINKS" -gt 0 ]; then
    fail "$BLANK_LINKS 处 book-btn/detail-btn 用了 target=\"_blank\" — 必须改成 onclick=\"CeliaBridge.invoke('surface.open', { url: 'xxx' })\"，半模态打开不离开路书"
else
    pass "无 book-btn/detail-btn 使用 target=\"_blank\""
fi

# ─── 10. CeliaBridge 实现走 window.CeliaApp.invoke ───
# Bug 模式：Agent 没读 references/celia-bridge.md 或读了但没照抄，自己编了个 bridge——
#   常见错误形式：postMessage / fetch / location.href / console.log 占位实现。
#   这些都不会到 Android 原生层（CeliaApp 是 WebView.addJavascriptInterface 注册的对象），
#   surface.open / map.navigate / favorite.add 全部静默失败，用户点了无反应。
#
#   只要 HTML 用了 CeliaBridge.invoke(...) 就 MUST 验证 bridge 实现里调了 window.CeliaApp.invoke。
echo
echo "--- 10. CeliaBridge 实现走 window.CeliaApp.invoke ---"
USES_BRIDGE=$(grep -c "CeliaBridge\.invoke" "$F" || true)
if [ "$USES_BRIDGE" -eq 0 ]; then
    info "未使用 CeliaBridge，跳过"
else
    HAS_CELIAAPP=$(grep -c "window\.CeliaApp\.invoke\|CeliaApp\.invoke" "$F" || true)
    if [ "$HAS_CELIAAPP" -ge 1 ]; then
        pass "CeliaBridge 实现调用了 window.CeliaApp.invoke (使用次数: ${USES_BRIDGE})"
    else
        fail "CeliaBridge.invoke 被调用 ${USES_BRIDGE} 次，但 bridge 实现里没有 window.CeliaApp.invoke — 编了个假桥（postMessage/fetch/console.log 等都到不了原生层），所有 surface.open/map.navigate/favorite 点击会静默失败。照抄 references/celia-bridge.md 的实现"
    fi
fi

# ─── 11. transit-next / flight-card 禁止 emoji，必须用 icon-X mask 系统 ───
# Bug 模式：Agent 写 transit-next 时直接 inline emoji <span class="transit-icon">🚗</span>，
#   或 flight-card 用 ✈ 字符，跨设备字体渲染参差不齐（彩色 / 单色 / 缺字符回退方块）。
#   现在 lushu/scripts/render-icons.mjs 提供了 walk/car/train/flight 四个 mask-image 图标，
#   HTML 必须用 <i class="transit-icon icon-X"></i> 形式。
echo
echo "--- 11. 交通图标用 mask 系统（禁止 emoji） ---"
TRANSIT_BLOCKS=$(grep -c 'class="transit-next"' "$F" || true)
FLIGHT_CARDS=$(grep -c 'class="flight-card"' "$F" || true)
if [ "$TRANSIT_BLOCKS" -eq 0 ] && [ "$FLIGHT_CARDS" -eq 0 ]; then
    info "无 transit-next / flight-card，跳过"
else
    # 11a. emoji 出现在 transit / flight 上下文（精确扫，避免误伤正文里偶然的 emoji）
    EMOJI_HIT=$(grep -nE 'class="(transit-icon|flight-icon)"[^>]*>[ \t]*[🚗🚆🚶✈️🚌🚲🛫⛴🚇🛵🛸🚐🛺🚙🛬🚂🚊🛣🚝🚄🚅✈]' "$F" || true)
    if [ -n "$EMOJI_HIT" ]; then
        cnt=$(echo "$EMOJI_HIT" | wc -l | tr -d ' ')
        fail "$cnt 处 transit-icon / flight-icon 用了 emoji — 必须改成 <i class=\"transit-icon icon-X\"></i>（4 个 class：icon-walk / icon-car / icon-train / icon-flight）。在 <head> 跑 node scripts/render-icons.mjs 拿 mask CSS 定义"
    fi

    # 11b. 检查 head 里是否注入了 render-icons CSS（icon-walk 等 class 的 mask-image 定义）
    HAS_ICON_CSS=$(grep -cE '\.icon-(walk|car|train|flight)' "$F" || true)
    if [ "$HAS_ICON_CSS" -lt 1 ]; then
        # 只在用了 transit-icon / flight-icon class 时才 fail
        USES_ICON_CLASS=$(grep -cE 'class="(transit-icon|flight-icon)( icon-(walk|car|train|flight))?"' "$F" || true)
        if [ "$USES_ICON_CLASS" -ge 1 ]; then
            fail "用到 transit-icon / flight-icon class 但 <head> 缺 .icon-X mask-image 定义 — 跑 node ~/.openclaw/workspace/skills/lushu/scripts/render-icons.mjs 把整段 <style> 输出粘到 head"
        fi
    fi

    # 11c. 禁 base64 mask-image：长 base64（>4000 字符）会让 LLM 重写时字符级幻觉，整张图坏掉
    #      render-icons.mjs 已经改成 URL 形式（指向 server static/lushu-icons/X.svg），任何 base64 嫌疑即 FAIL
    BASE64_HIT=$(grep -cE '\.icon-(walk|car|train|flight)[^{]*\{[^}]*data:image/svg\+xml;base64' "$F" || true)
    if [ "$BASE64_HIT" -gt 0 ]; then
        fail "$BASE64_HIT 个 .icon-X 用了 base64 mask-image — 长 base64 会被 LLM 重写时字符级幻觉，必须改成 URL 形式（mask-image: url(\"…/static/lushu-icons/X.svg\")）。跑 node scripts/render-icons.mjs 拿新版"
    fi

    if [ -z "$EMOJI_HIT" ] && [ "$HAS_ICON_CSS" -ge 1 ] && [ "$BASE64_HIT" -eq 0 ]; then
        pass "交通图标走 mask 系统（URL 引用，非 base64）"
    fi
fi

# ─── 12. 价格字段禁止 ¥Nxx 占位符 ───
# Bug 模式：Agent 没查 FlyAI 但又不愿空着 price 字段，自己脑补出"¥4xx/晚 / ¥1xx / ¥3XX"
#   等占位符。看上去像变量没替换 / 系统 bug，破坏用户信任。
# 规则（references/essentials.md「价格字段写法」section）：
#   - 有真实数据 → 真实数字（¥1,240）
#   - 无真实数据 → 起价加号（¥400+/晚）或整段省略 price 字段
#   - 永远不允许 Nxx / NXX 占位形式
echo
echo "--- 12. 价格字段禁止 ¥Nxx 占位符 ---"
PLACEHOLDER_HIT=$(grep -nE '¥[0-9]+[xX][xX]|¥[0-9]+\?+' "$F" || true)
if [ -n "$PLACEHOLDER_HIT" ]; then
    cnt=$(echo "$PLACEHOLDER_HIT" | wc -l | tr -d ' ')
    fail "$cnt 处 ¥Nxx 价格占位符 — 看上去像系统 bug。要么放 FlyAI 真实数字，要么用起价形式 ¥N00+（如 ¥400+/晚），要么删掉整个 price 字段"
    echo "$PLACEHOLDER_HIT" | sed 's/^/      /'
else
    pass "无 ¥Nxx 价格占位符"
fi

# ─── 总结 ───
echo
echo "=== SUMMARY ==="
echo "✅ PASS: $PASS_COUNT"
[ "$WARN_COUNT" -gt 0 ] && echo "⚠️  WARN: $WARN_COUNT — 对照 references/essentials.md「交通过渡提示」section 决策清单核对，确认漏加就 Edit 补"
[ "$FAIL_COUNT" -gt 0 ] && echo "❌ FAIL: $FAIL_COUNT — 必须用 Edit 工具修补，再次跑本脚本直到 EXIT 0"

if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
elif [ "$WARN_COUNT" -gt 0 ]; then
    exit 2
else
    exit 0
fi
