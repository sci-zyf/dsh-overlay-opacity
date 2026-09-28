# dsh-overlay-opacity · 浮层不透明度

给 DSH Web GUI 的**浮层底填充**单独加一个透明度控制。只改两枚设计变量的 alpha，
颜色仍然完全跟随主题。

| 变量 | 管什么 |
| --- | --- |
| `--dsw-specific-menu` | 菜单 / 下拉 / **“/” 命令浮层** |
| `--dsw-alias-bg-overlay` | 弹窗 / 浮层底 |

## 为什么需要它

DSH 的页面底色（`--dsw-alias-bg-base`）在挂壁纸时被置为透明，浮层自带的半透明
底就会直接透出壁纸。主题里 `--dsw-specific-menu` 的取值：

- 非 darwin：`--dsw-menu-surface-fill` → 浅色 `#f8f9fa94`（58%）、深色 `#43454a73`（45%）
- darwin：`#f8f9faf0`（94%）、深色 `#303136f0`

于是同一层在不同平台/主题下可读性差异很大，而多数皮肤插件（包括
`dsh-plugin-wallpaper-engine`）**并不接管这两枚变量**，插件里也就没有对应开关。
本插件只做这一件事：把它们钉到你选的透明度。

## 用法

安装后打开 **设置 → 浮层不透明度**：

- **启用**开关：关掉即还原为宿主原值（本插件不写任何 CSS 层，只写内联变量）。
- **菜单 / 下拉 / 命令浮层**：滑块 0–100%，越大越实。
- **弹窗 / 浮层底**：同上，默认 100%（即不动它，仅在你主动调低时生效）。
- 每行下方显示该变量当前解析出的实际色值，便于判断是否生效。
- **恢复默认**：一次还原两项。

改动即时生效，并保存到 `~/.dsh-overlay-opacity/config.json`。

## 实现要点

- **用内联自定义属性而非注入 CSS**：rc.7+ 把主题调色板做成插件样式表，注入时机
  晚于第三方插件样式，普通 CSS 规则会被压过；写 `documentElement` 的内联变量是
  最高优先级，且不必和宿主比选择器权重。
- **先探测再覆盖**：两枚 token 的值是 `var()` 链（例如
  `--dsw-specific-menu: var(--dsw-menu-surface-fill)`），自定义属性的 computed
  value 不解析 `var()`，直读会拿到字面量字符串。因此把 token 挂到探针元素的
  `background-color` 上读解析后的 `rgb()/rgba()`，只替换 alpha。
- **主题跟随**：`MutationObserver` 监听 `data-platform` 与 `data-ds-dark-theme`，
  切换明暗/平台时重新探测原色。属性过滤里**不含** `style`，避免自己写变量触发
  自己形成写-观察死循环。
- **持久化走宿主文件**：DSH Desktop 每次启动换随机端口，origin 变化会让
  `localStorage` 恒空，设置每次重启丢失。
- **零 `@deepseek-ai/*` 依赖**：host/装配差异不该让一个只读写 JSON 的插件加载失败。

## 目录

```
client.js          浏览器半边（本插件全部逻辑）
lib/index.js       host 半边：配置读写 + GET/POST /overlay-opacity/settings
cordis.patch.yml   把插件挂成一行
```

## 卸载

从 profile 移除依赖与 bundle 项后重新安装依赖即可；`~/.dsh-overlay-opacity/`
可留可删。

## License

MIT
