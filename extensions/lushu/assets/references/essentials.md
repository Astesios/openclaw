# 路书必读模板（每次生成都要按本文实现）

每次触发 lushu 都要 read 本文一次。三个模块（Sticky Tab / Transit Next / FlyAI Cards）覆盖路书生成的「必有规范」，缺一不可。

## 目录

- [Sticky Tab + 顶部遮罩条 + Scroll 行为](#sticky-tab)
  - HTML 结构 / CSS / JavaScript / 关键值 / 不允许的写法 / 已知陷阱
- [交通过渡提示 transit-next](#transit-next)
  - 决策清单 / 自查公式 / HTML / CSS / 交通方式选择 / 数据来源 / 与地图协同 / 点击行为
- [FlyAI 数据卡片](#flyai-cards)
  - 航班 / 酒店 / 景点卡片模板 / 预订链接处理

---

## <a name="sticky-tab"></a>Sticky Tab + 顶部遮罩条 + Scroll 行为

DAY Tab 吸顶交互的规范。**完整可执行 HTML/CSS/JS 见 [example-skeleton.html](example-skeleton.html)**——本节给"为什么"和"反模式"，模板照搬例子即可。

### 视觉模型

```
┌─────────────────┐ ← viewport top (0)
│ status bar      │ 0-30px（系统）
│ X / 分享 / ✓    │ 30-90px（native 按钮，叠在 WebView 之上）
├─────────────────┤
│ ▒▒▒ top-cover ▒│ 0-100px（fixed 纯色遮罩，hero 滚出后显示）
│  [DAY 1 2 3 ...] │ 100px 起 sticky tab
└─────────────────┘
```

**关键设计**：
- `tabs-nav` sticky 在 `top: 100px`，让出上方给 status bar + native 按钮
- 0-100px 是 sticky 缝隙，**会透出下层 day-title**
- 用独立 `.top-cover` fixed 在 0-100px，hero 滚出后才显示，遮蔽缝隙

### 三块 JS 缺一不可

| 块 | 作用 |
|---|---|
| `scrollRestoration='manual'` + 800ms `scrollTo(0,0)` polling | demo-app-c WebView 加载后会自动滚到 hero 底部，单次 scrollTo 被覆盖，需 800ms 持续 force |
| `IntersectionObserver` 监听 hero 出可见区 → 切 `.top-cover.show` | rootMargin `-100px 0 0 0` 把 cover 覆盖区从判定剔除，否则切 tab 后 cover 不亮、hero 漏出 |
| `showDay(n)` 切 active class + `scrollIntoView` | 靠 `.day-section { scroll-margin-top: 150px }` 让出 sticky 遮罩高度；RAF 等 display:block layout 完成再滚 |

### 关键值（不要改）

| 值 | 原因 |
|---|---|
| `top: 100px` | 让出 status bar (~30) + native title bar (~70)，少了被按钮遮，多了视觉空白条 |
| `top-cover height: 100px` | 与 sticky top 完全对齐，确保 0-100px 缝隙被填满 |
| `transition opacity 0.2s` | 与 sticky 切换的视觉节奏一致 |
| `IntersectionObserver threshold: 0` | hero 任一像素离开 "可见区" 就触发，最敏感 |
| `IO rootMargin -100px 0 0 0` | 顶部 100px 是 cover 覆盖区，hero 在该带内露脸应当视作"已离开"，否则切 tab 后 cover 不亮、hero 漏出 |
| `.day-section scroll-margin-top: 150px` | scrollIntoView 时让出 cover (100) + nav (~50)，否则 day 顶部前 100-150px 内容被遮罩盖住 |
| `scrollTo polling 800ms` | demo-app-c WebView 在 onPageFinished 后约 500-700ms 内有自动滚动行为，800ms 留余量 |

### 不允许的写法

- ❌ `tabs-nav` 用 `rgba(255,255,255,0.92) + backdrop-filter: blur` — Android WebView 上 backdrop-filter 不可靠，下层文字仍透出
- ❌ `tabs-nav padding-top: 100px` 替代 sticky `top: 100px` + `top-cover` — 会让初始状态 hero 下方多 100px 空白条
- ❌ 单次 `window.scrollTo(0, 0)` 替代 polling — WebView 会覆盖，必须持续 force 800ms
- ❌ 省略 `top-cover` — sticky 的 0-100px 缝隙会暴露 day-title
- ❌ `showDay` 用 `scrollTo({ top: nav.offsetTop })` — `nav.offsetTop` ≈ hero 高度，滚到此处 day-section 顶部恰好进入 viewport y≈50，被 cover (0-100) 和 sticky nav (100-150) 联合盖住前 ~100px，看到的是 day 中段
- ❌ `IntersectionObserver` 不带 `rootMargin: '-100px 0 0 0'` — tab 切换后 hero 仅在 viewport 0-100 内残留时仍被判 intersecting，cover 不亮 → hero 漏出

### 已知陷阱

- demo-app-c WebView 在加载后自动 scroll 到 hero 底部（约 0.8 × viewport），polling 修复
- `position: sticky` 在某些 WebView 实现下若父元素 `overflow: hidden` 会失效 → hero / body 不要加 overflow
- `IntersectionObserver` 在 hero 高度 0 / 未 layout 时可能误报，但 WebView Chromium 实现稳定

---

## <a name="transit-next"></a>交通过渡提示 transit-next

每个 `timeline-item` 描述完后，可紧跟一个 `.transit-next` 元素，显示到下一站的交通信息（图标 + 方式 + 距离/时间 + 可选下一目的地名）。视觉上灰色小字、可点击。

### ⚠️ 决策清单：每个 timeline-item 是否加 transit-next

按顺序判断，命中任一"省略"条件就跳过：

**省略**：
- ❌ 当天最后一个 timeline-item（无"下一站"）
- ❌ 下一个 timeline-item 与当前**同一地点**（如酒店 morning/afternoon/evening 都在房间内）
- ❌ 跨城段已有 FlyAI 航班/火车卡片承担过渡（避免重复信息）
- ❌ 当前 item 是"下榻 / 入住 / 抵达酒店"且下一项就在该酒店内（视为同地点）

**加**：
- ✅ 上述都不命中，即"两个不同地点之间"的过渡

### ✅ 生成完路书后自查

对每个 day 单独核算：

```
该 day timeline-item 数 = N
该 day 同地点连续段合并后剩余位置 = M（一般 M ≤ N）
预期 transit-next 数 = M - 1（最后位置不加）

实际 grep 数对得上，否则补/删
```

**典型校验**（南疆 5 天行程）：
- Day1：抵达机场 → 古城 → **1 个 transit-next** ✓
- Day2：白沙湖 → 塔什库尔干 → **1 个 transit-next** ✓
- Day5：库车大峡谷 → 克孜尔石窟 → **1 个 transit-next** ✓

如果某 day 全是"酒店 morning/afternoon/evening"这种同地点段，则 0 个 transit-next。

### 图标系统

**禁止 emoji**（🚗/🚆/🚶/✈️ 等）—— 用 lushu 自带图标系统：

- `<head>` 内执行 `node ~/.openclaw/workspace/skills/lushu/scripts/render-icons.mjs`，把整段 `<style>` 输出粘进去（位置紧跟 render-map.mjs 的 head 块），定义 `.transit-icon` / `.flight-icon` 基础尺寸 + 4 张 mask-image 图标
- mask-image 通过 URL 引用 server 上的 SVG（`/static/lushu-icons/X.svg`），不是 inline base64 —— 避免 LLM 重写时字符级幻觉
- HTML 用法：`<i class="transit-icon icon-walk"></i>`
- 4 个 class：`icon-walk` / `icon-car` / `icon-train` / `icon-flight`
- 颜色靠 `currentColor` 跟主题，不需要给 svg 单独写颜色
- 缺图标（如 bus / subway / ferry）暂时降级用文字描述，**不允许**回退到 emoji
- 首次部署或新增图标后，需要跑 `bash scripts/sync-icons.sh` 把 SVG 同步到 server static 目录，否则 WebView 拉图会 404

### HTML 模板

```html
<div class="timeline-item">
  <span class="timeline-time">09:55</span>
  <div class="timeline-content">
    <h3>抵达秦皇岛北戴河机场</h3>
    <p>...</p>

    <!-- 交通过渡：到下一站 -->
    <div class="transit-next" data-capability="map.navigate" data-target="阿那亚社区">
      <i class="transit-icon icon-car"></i>
      <span class="transit-info">专车前往阿那亚社区，车程约30分钟</span>
      <span class="transit-arrow">›</span>
    </div>
  </div>
</div>
```

带具体距离 + 下一站名的简版：

```html
<div class="transit-next">
  <i class="transit-icon icon-walk"></i>
  <span class="transit-info">步行 800m · 12min</span>
  <span class="transit-info-next">→ 孤独图书馆</span>
  <span class="transit-arrow">›</span>
</div>
```

### CSS 样式

```css
.transit-next {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding: 4px 0;
  font-size: 13px;
  color: var(--secondary, #A69F95);
  cursor: pointer;
  transition: opacity 0.2s;
}
.transit-next:active,
.transit-next:hover { opacity: 0.6; }

/* .transit-icon 的尺寸 / display / flex-shrink / mask-image 全部由 render-icons.mjs 输出的 <style> 统一定义，
   这里不要再写 .transit-icon 规则，避免双份真相 / 漂移。 */
.transit-info { flex: 0 0 auto; }
.transit-info-next {
  flex: 0 0 auto;
  margin-left: 4px;
}
.transit-arrow {
  margin-left: auto;
  font-size: 18px;
  font-weight: 300;
  color: var(--secondary, #A69F95);
}
```

按风格调整：
- 极简杂志 / 优雅编辑：保留细线条 svg 图标，颜色用 `var(--secondary)` 灰
- 沉浸手帐：图标可以用钢笔手绘风（`stroke-dasharray` 模拟），颜色用墨棕 `#8B6914`
- 动态杂志：图标加微动画（hover 平移 2px），颜色 `#4A4A4A`

### 交通方式选择规则

按距离 + 行程文本上下文自动选：

| 距离 | 图标 class | 文案模板 |
|------|------|---------|
| < 1km | `icon-walk` 步行 | `步行 Xm · Xmin` |
| 1-50km（市区） | `icon-car` 驾车 | `驾车 Xkm · Xmin` 或 `专车 Xmin` |
| 50-300km（跨城） | `icon-train` 高铁 | `高铁 Xh Xmin`（暂无 bus 图标，长途客车也用 icon-car） |
| > 300km（远程） | `icon-flight` 航班 | `航班 Xh Xmin` |

**重点**：以**行程文本明确指定的交通方式**为准（例如"乘高铁前往烟台"必须用高铁图标，无论距离）。距离表只是兜底估算。

### 数据来源

**静态填值（推荐）**：Agent 在生成路书时，根据行程文本和地图常识直接填具体数字。例如：
- 行程写"专车前往阿那亚社区" → `专车前往阿那亚社区，车程约30分钟`（数据来自高德地图常识）
- 行程写"步行至孤独图书馆" → `步行 800m · 12min`（800m / 5km/h ≈ 10min）

**动态计算（可选，复杂场景）**：调 `driving.search` 单独查每段：
```javascript
driving.search(stops[i].lnglat, stops[i+1].lnglat, function(status, result) {
  if (status === 'complete') {
    var seg = result.routes[0];
    var distKm = (seg.distance / 1000).toFixed(1);
    var minutes = Math.round(seg.time / 60);
    document.querySelector('#transit-' + i).innerText = '驾车 ' + distKm + 'km · ' + minutes + 'min';
  }
});
```

但这会发起多次 SDK 请求，且在弱网下显示空白。**默认走静态填值，只有用户明确要"实时数据"时才用动态**。

### 与地图轨迹的协同

`render-map.mjs` 输出的地图把所有 stops 用一条 polyline 连接。`transit-next` 是每段独立的文字描述。两者**数据应一致**：
- stops[0] → stops[1] 的 transit 文案 = 地图开头那段路线的实际距离/时间
- 如果地图 driving.search 失败走了 fallback 直线，transit 也不要出现（或注明"路线规划失败"）

### 点击行为

`.transit-next` 可挂 CeliaBridge 调用拉起原生地图导航：

```html
<div class="transit-next" onclick="CeliaBridge.invoke('map.navigate', {
  name: '阿那亚社区',
  lat: 39.83,
  lng: 119.52
})">...</div>
```

详见 [references/celia-bridge.md](celia-bridge.md)。

---

## <a name="flyai-cards"></a>FlyAI 数据卡片

用 FlyAI 查到的真实数据替代静态文本，三种卡片模板。**结构按下方示意，实际样式必须严格匹配所选路书风格**（手帐风用拼贴/拍立得，杂志风用简约排版等）。

### 航班卡片

```html
<div class="flight-card">
  <div class="flight-route">
    <span class="city">深圳</span>
    <i class="flight-icon icon-flight"></i>
    <span class="city">秦皇岛</span>
  </div>
  <div class="flight-info">CZ6280 · 06:40-09:55</div>
  <div class="flight-price">¥1,240</div>
  <a href="javascript:void(0)" class="book-btn" onclick="CeliaBridge.invoke('surface.open', { url: 'https://...' })">预订机票</a>
</div>
```

### 酒店卡片

```html
<div class="hotel-card">
  <img src="https://..." loading="lazy" />
  <div class="hotel-info">
    <h3>安澜酒店·Aranya</h3>
    <div class="hotel-meta">国宾大床房 · 连住2晚</div>
    <div class="hotel-rating">⭐ 4.8</div>
    <div class="hotel-price">¥2,680/晚</div>
  </div>
  <a href="javascript:void(0)" class="book-btn" onclick="CeliaBridge.invoke('surface.open', { url: 'https://...' })">预订酒店</a>
</div>
```

### 景点卡片

```html
<div class="poi-card">
  <img src="https://..." loading="lazy" />
  <h3>阿那亚礼堂</h3>
  <div class="poi-meta">⭐ 4.8 · 免费</div>
  <a href="javascript:void(0)" class="detail-btn" onclick="CeliaBridge.invoke('surface.open', { url: 'https://...' })">查看详情</a>
</div>
```

### 预订链接处理

- FlyAI 返回的 `jumpUrl` / `detailUrl` 写到 `onclick="CeliaBridge.invoke('surface.open', { url: 'xxx' })"` 里
- **默认用 `surface.open` 半模态打开**（路书 App WebView 内浮层渲染，不离开路书页），不要再用 `target="_blank"` 跳浏览器
  - 半模态 UX：浮层从路书页之上覆盖出来，下拉手势 / 点击外部 / 系统返回键关闭，关闭后回到原路书位置
  - 浏览器打开会让用户离开路书，再回来要重新滚动找位置，破坏沉浸感
- 按钮文案：航班 → "预订机票"，酒店 → "预订酒店"，景点 → "查看详情"
- FlyAI 数据不可用时降级为静态卡片（无价格 / 链接），不阻断路书生成
- App 之外的浏览器打开 HTML 时，`CeliaBridge.invoke` 是 noop（不报错也无反应），不影响阅读

### 价格字段写法（重要）

| 场景 | 写法 | 例子 |
|---|---|---|
| FlyAI 拿到真实价格 | 真实数字 | `¥1,240` / `¥2,680/晚` |
| 没查 FlyAI / 查不到 | **起价 + 加号**（具体整百数字 + `+`） | `¥400+/晚` / `¥1,500+` |
| 完全无概念 | **省略整个 price 字段**，连 `<div>` 都不要 | — |

❌ **绝对禁止**：`¥4xx/晚` / `¥1xx` / `¥3XX/晚` / `约 200-300 元` 等占位符或模糊区间。
- 看上去像系统 bug 或变量没替换，破坏用户信任
- "起价 +" 形式（`¥400+`）传达了"约 400-500 一晚"的语义，但是**真实数字**，用户能 parse
