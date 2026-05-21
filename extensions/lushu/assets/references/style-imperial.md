### 风格五：国风路书 (Imperial Chinese · 宫墙红金)

```
模式：宫墙红金主题的卷轴式行程叙事 (Vermilion-walled Imperial Itinerary Scroll)
CTA：极简金色描边按钮 / 印章式入口 (Gold Hairline Outline Button / Seal-style Entry)
区块：
  1. 顶部全屏故宫/古建筑大片 + 底部 mask 渐隐到红墙背景 (Cinematic Hero with Bottom Mask Fade)
  2. 大字毛笔标题（古都名/旅程主题），下方衬线英文小标 + 朱红日期印章
  3. 行程元数据条 (DURATION / DISTANCE / SEASON 三栏，DM Mono 标签 + Cormorant 大数字)
  4. 居中下划线式日期 Tab (DAY 壹 / 贰 / 叁，金色短下划线指示选中)
  5. 时辰时间轴 + 站点大图卡片 (辰时/巳午/未时/酉戌 等天干地支时辰文字 + 编号"壹/贰/叁"印章节点)
  6. 卡片落角朱印 + 金色描边角花 + 数字徽章
  7. 高德地图 (whitesmoke 风格) 嵌入，配金色描边外框
  8. 拉引语 .pull — 上下细金线 + 居中毛笔字 + 极小英文副标
  9. 落款 colophon — 印章 + 撰文者/日期 + 极简编号

风格：故宫/紫禁城气韵，沉稳隆重，宣纸肌理，朱红与黄金的对比张力
关键词：朱砂红 (#8B1A1A)，皇家金 (#D4AF37)，宣纸米 (#F3E4C8)，墨黑 (#1A1410)，
        毛笔字大标题，时辰天干地支，朱印，金色细描边，
        卷轴叙事节奏，极少使用渐变色块（仅顶部头图 mask）

配色：
  主背景 (phone shell)：linear-gradient(180deg, #8B1A1A 0%, #7A1414 30%, #6B1212 100%)
                        + radial-gradient(top, rgba(212,175,55,0.10), transparent 60%)
  深背景变体 (ink tone)：linear-gradient(180deg, #3A1414 0%, #2C0E0E 60%, #240A0A 100%)
                        ⚠️ 不能纯黑收尾 — 底部最深色不低于 #240A0A，保持暖红墨色基调
  浅背景变体 (rice tone)：宣纸米 #F3E4C8 / #E6CFA3，文字反白为深墨

  主色 (强调/标题/印章红)：#8B1A1A / #B22222 (朱砂)
  皇家金 (装饰/边框/高亮)：#D4AF37 / #C9A961 (旧金)
  宣纸米 (卡片底/正文反衬)：#F3E4C8 / #E6CFA3
  墨黑 (深色文字)：#1A1410 / #3A2A20
  青绿 (极少量点缀)：#4F6F52
  辅助色 (描边/分隔)：rgba(212,175,55, 0.18~0.5) 一律金色透明度变体

排版：
  大标题/毛笔字：Ma Shan Zheng (毛笔字，用于头图主标 / 站点中文名 / 时辰文字)
  正文中文：Noto Serif SC (思源宋体) wght 400-600
  装饰英文/数字 (副标/角花/年份)：Cormorant Garamond (italic / regular)，宽字距
  辅助标签 (DURATION / DAY · 01 / KM 单位)：DM Mono，全大写，letter-spacing 0.2em+
  备选：ZCOOL XiaoWei (装饰副标)，Long Cang (落款手写)

字号节奏 (375-420px shell 内)：
  头图主毛笔字：64-96px
  站点中文名：32-44px (毛笔字)
  日期 Tab 中文：17px Noto Serif SC 600 + 10px Cormorant 副标
  正文：14-15px Noto Serif SC，行高 1.85
  时辰小标：10-11px DM Mono，宽字距
  meta-row 大数字：28px Cormorant Garamond

关键特效与细节：
  - 头图 mask 渐隐：mask-image: linear-gradient(180deg, #000 0%, #000 70%, transparent 100%)
    让大图自然融入红墙背景，杜绝硬边
  - 朱印 / 印章：方形 (12-22px) 朱砂红底 + 金色描边 + 极小毛笔字 (壹/贰/叁/京/禁/食…)
    可加 SVG 噪点 mask 制造斑驳感，节点印章可微旋 ±3°
  - 金色描边：所有装饰边框统一 1px solid rgba(212,175,55, 0.4-0.6)，杜绝粗边和大圆角 (max 6px)
  - 卡片角花：每个图卡四角放金色"L"形或回字纹 SVG，1px stroke
  - 时间轴：左侧 1px 金色虚线 + 时辰文字 (辰时·朝 / 巳午·正 / 酉戌·夜 等)
    时辰节点用编号印章 (壹/贰/叁) 替代圆点
  - 日期 Tab：仅文字 + 选中下划线 (72px 金色 2px)，无底色无边框，未选 60% 透明度
  - 拉引语 .pull：上下两条 1px 金色实线 rgba(212,175,55,0.45)，居中毛笔字
    ⚠️ 不要使用 linear-gradient 渐变线，统一为描边
  - 元数据条 meta-row：3 栏 grid，左右金色细分隔线，无顶部金色短粗条装饰
  - 印章式徽章 chip：胶囊形，金底 + 红字 / 透明 + 金边
  - 日终块 .day-end：无虚线/无描边，仅居中毛笔字 + Cormorant 英文小标

地图风格：amap://styles/whitesmoke + 自定义站点 marker 用朱印图标，
        路径线 strokeColor #D4AF37 strokeWeight 2 strokeOpacity 0.85
  （render-map.mjs --style imperial 已封装该配色，不需要手写）

避免：
  - 大面积渐变红黑过渡 (尤其底部不可收成纯黑 #000)
  - emoji / 卡通图标
  - 圆角 > 8px
  - 粗描边 (>1.5px)
  - 紫 / 蓝 / 任何与红金体系冲突的强彩色
  - 渐变色横线 / 装饰短粗条 (一律改为均匀描边)
  - 头图与下方背景之间出现明显色差硬边 — 必须用 mask 渐隐

页面结构示例（移动端 phone shell, max-width 420px）：
  <hero-image>              全屏古建筑照片 + 底部 mask 渐隐
    └ <hero-title>          毛笔大字主题 + 衬线英文副标 + 朱印日期
  <meta-row>                DURATION / DISTANCE / SEASON
  <tabs-wrap>               日期 tab (壹/贰/叁 · DAY 01/02/03)
  <day-section>×N
    └ <stop>×N
        ├ <marker>          "壹/贰/叁" 印章
        ├ <time-slot>       辰时·朝 / 巳午·正 / 酉戌·夜
        └ <card>
            ├ <card-img>    站点照片 + 角花 + 朱印徽章 + 站点中文/英文名
            └ <card-body>   <h3 headline> + <desc 正文> + <chips> + <tip 注>
  <pull>                    每日拉引语 (上下金线 + 毛笔字 + 英文副标)
  <day-end>                 日终块 (无边框，仅居中毛笔字 + Cormorant 英文)
  <colophon>                落款印章块
```
