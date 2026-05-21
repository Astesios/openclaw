### 风格三：沉浸手帐风 (Immersive Scrapbook)

```
模式：拼贴手账式物理拟态界面 (Collage Scrapbook Immersive Interface)
区块：
  1. 顶部手撕纸边通栏 Banner (支持点击换图，带黄色/薄荷绿和纸胶带)
  2. 手绘书签式 Tab 切换区 (选中状态加深背景色与阴影)
  3. 虚线轨迹时间线 & 错位叠放卡片 (底层垫纸旋转实现多层肌理)
  4. 现代化拼贴机票卡片 (两侧半圆切角，虚线轨迹两端渐变消失)

字体排版：
  - 大标题 & Tab 中文：Ma Shan Zheng (马善政毛笔字，20px+)
  - 卡片正文 & 标题中文：ZCOOL KuaiLe (站酷快乐体)
  - 英文/数字/涂鸦提示：Caveat (手写连笔)
  - 副标题英文：Indie Flower

配色：
  主墨水色 (文本/边框)：#3E2723 (深棕墨水色)
  强调褐 (重点信息)：  #6D4C41
  半透明强调色：        rgba(109, 76, 65, 0.5)
  打卡邮戳红：          #D32F2F
  胶带色系：薄荷绿 rgba(129,199,132,0.7) / 暖黄 rgba(255,213,79,0.7)
  纸张底色：外层 #D7D2CB / 表层纸 #FDFBF7 / 底层垫纸 #E6E0D4

特定组件：
  - 机票卡片：mask-image: radial-gradient 裁出两侧半圆缺口
  - CTA 按钮：胶囊形 (border-radius: 50px)，#6D4C41，-1.5° 微倾斜
  - 邮戳盖章：SVG 噪点 Mask (feTurbulence) 模拟斑驳感

关键物理特效：
  - 全局 SVG 纸质噪点 (opacity 3%-5%)
  - 卡片底层错位垫纸 (::before 伪元素，反向旋转)
  - 胶带 mix-blend-mode: multiply 透出纸张纹理

避免：笔直锋利线条，极简冷酷纯色渐变，纯黑 #000000，数字感发光特效
```
