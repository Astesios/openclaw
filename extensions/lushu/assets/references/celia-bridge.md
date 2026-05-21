# CeliaBridge 能力调用

路书在 App 的 WebView 中展示时，可通过 JS Bridge 调用原生能力（地图导航、收藏地点等）。浏览器打开时按钮点击无响应，不影响阅读。

## Bridge 定义

在 HTML `<script>` 中：

```javascript
// CeliaBridge — 路书 → App 原生能力调用
var CeliaBridge = {
  invoke: function(capability, params) {
    // Android WebView JS Bridge
    if (window.CeliaApp && window.CeliaApp.invoke) {
      window.CeliaApp.invoke(JSON.stringify({
        capability: capability,
        params: params || {}
      }));
    }
  }
};
```

## 调用按钮示例

```html
<!-- 导航到某地点 -->
<button onclick="CeliaBridge.invoke('map.navigate', {
  name: '安澜酒店',
  lat: 39.83,
  lng: 119.52
})">导航到这里</button>

<!-- 收藏地点 -->
<button onclick="CeliaBridge.invoke('favorite.add', {
  name: '阿那亚礼堂',
  address: '秦皇岛市北戴河新区',
  lat: 39.84,
  lng: 119.51,
  category: '景点'
})">收藏</button>

<!-- 查看完整路线（拉起地图 App） -->
<button onclick="CeliaBridge.invoke('route.plan', {
  from: '秦皇岛机场',
  to: '安澜酒店·Aranya'
})">查看路线</button>

<!-- 打开半模态 WebView 渲染指定 url（详情页 / 攻略文章 / 商家页面等） -->
<button onclick="CeliaBridge.invoke('surface.open', {
  url: 'https://www.dianping.com/shop/G0bHPZmkTZQYpQOA'
})">查看店铺详情</button>
```

## 能力清单

| capability | 参数 | 行为 |
|------------|------|------|
| `map.navigate` | `name, lat, lng` | 拉起高德地图导航 |
| `favorite.add` | `name, address, lat, lng, category` | 收藏地点 |
| `route.plan` | `from, to` | 拉起地图 App 规划路线 |
| `surface.open` | `url` | **在路书页之上叠加半模态 WebView 渲染该 url**，下拉手势/点击外部关闭。适合详情页、攻略文章、商家页面等不需要离开路书页的浅层内容嵌入 |

## 注意事项

- CeliaBridge 仅在 App WebView 中生效；浏览器打开时按钮点击无响应，不影响阅读
- 能力按钮样式应匹配所选路书风格，不要用突兀的 UI
- `surface.open` 适合**浅层内容**（详情页/介绍文章），需要复杂交互或长停留的场景仍用 `target="_blank"` 跳浏览器
- `surface.open` 关闭后 WebView 状态丢弃，下次打开重新加载
