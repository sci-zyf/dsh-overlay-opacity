// dsh-overlay-opacity — client (web) half.
//
// 只做一件事：把「浮层底填充」的 alpha 换成用户设定的值，颜色仍完全跟随主题。
//
// 被接管的变量（全部声明在 body 上）：
//
//   --dsw-menu-surface-fill   菜单材质底色。MenuSurface 的 .material 直接读它，
//                             “/” 命令面板、所有 MenuSurface 菜单吃这一枚。
//   --dsw-specific-menu       另一批弹层组件（jobs / schedule / chat 统计弹窗等）用。
//   --dsw-alias-bg-overlay    弹窗底。本版 DSH 里只有「提问弹层」在用。
//
// 另外恢复 [data-menu-backing] 的底色：macOS 上 MenuSurface 会往 body portal 一个
// 「不透明背板」（background: var(--dsw-alias-bg-base)），让 Chromium 的
// backdrop-filter 有东西可采样。壁纸类插件把 --dsw-alias-bg-base 置为 transparent
// 后，这块背板整体消失，菜单就只剩自身 45%–58% 的材质 —— 这是“命令面板很透”的主因之一。
//
// 三个必须踩准的点：
//
//   1. 覆盖写在 body 上，不能写 html。主题把这几枚 token 声明在 body{...} /
//      body[data-ds-dark-theme]{...} 上；自定义属性虽然会继承，但 body 自己的声明
//      会压过从 html 继承来的值 —— 写 html 等于没写。
//   2. 用带 !important 的样式表规则，而不是只靠内联。内联的优先级只高于普通声明；
//      样式表 + !important 则不受来源与顺序影响。
//   3. 值要「先探测再覆盖」。这些 token 是 var() 链，自定义属性的 computed value
//      不解析 var()，直读只能拿到字面量字符串。所以把 token 挂到探针元素的
//      background-color 上读解析后的 rgb()/rgba()，只替换 alpha。
//
// 设置页每行同时显示「写入值」与「实测值」：后者是把覆盖挂上之后再探测一次读回来的，
// 两者不一致就说明覆盖没赢 —— 用来区分「插件没写对」和「写了但被别的东西压过」。
//
// 持久化走宿主文件（见 lib/index.js）：DSH Desktop 每次启动换随机端口，origin
// 一变 localStorage 就恒空。

if (typeof window !== "undefined" && window.__ModuleLoader__) {
	window.__ModuleLoader__.load({
		id: "dsh-overlay-opacity",
		factory: (require) => {
			"use strict";
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

			exports.name = "dsh-overlay-opacity";

			/** 平台 seed 缺失时降级为「不存在但不报错」，绝不白屏宿主。 */
			const requireSeed = (name) => {
				try {
					return require(name);
				} catch {
					return null;
				}
			};

			const React = requireSeed("react");
			// 没有 DOM 就没有浮层可调：导出空实现，绝不在非浏览器环境抛错。
			if (React === null || typeof document === "undefined") {
				exports.apply = () => {};
				exports.inject = [];
				return module.exports;
			}

			const h = React.createElement;

			/**
			 * 一组滑块 = 一组同语义的 token。
			 *
			 * restoreBacking 为真时，同时用主题实色层把 [data-menu-backing] 补回实色，
			 * 让 macOS 的菜单毛玻璃重新有底可采样。
			 */
			const GROUPS = [
				{
					key: "menu",
					label: "菜单 / 下拉 / 命令浮层",
					hint: "输入框敲 “/” 弹出的命令面板属于这一层",
					def: 0.97,
					tokens: ["--dsw-menu-surface-fill", "--dsw-specific-menu"],
					restoreBacking: true,
				},
				{
					key: "overlay",
					label: "提问弹层的底",
					hint: "本版 DSH 里 --dsw-alias-bg-overlay 只被「提问弹层」消费，所以这个滑块能看见的变化很窄",
					def: 1,
					tokens: ["--dsw-alias-bg-overlay"],
					restoreBacking: false,
				},
			];

			/** 背板补色用的主题实色层（body 上一定有，且是实色）。 */
			const BACKING_BASE_TOKEN = "--dsw-alias-bg-layer-1";
			/** 选择器：body 上的三态（浅色 / 深色 / darwin）一次覆盖。 */
			const RULE_SELECTOR = 'body, body[data-ds-dark-theme], html[data-platform="darwin"] body';

			const STYLE_ID = "dsh-overlay-opacity-style";
			const SETTINGS_URL = "/overlay-opacity/settings";
			const DEFAULTS = { enabled: true, menu: 0.97, overlay: 1 };

			/** 当前生效设置（响应式，见 useOverlayState）。 */
			const state = { ...DEFAULTS };
			/** 写入值 / 实测值，供设置页展示。 */
			const written = {};
			const measured = {};
			/** 探测到的主题原色：{ [key]: { [token]: {r,g,b,a} } }。null = 尚未探测。 */
			let originals = null;
			/** 探测到的实色层 RGB（背板用）。 */
			let backingBase = null;

			const listeners = new Set();
			function emit() {
				for (const listener of listeners) {
					try {
						listener();
					} catch {
						/* 其它订阅者的异常不该影响渲染 */
					}
				}
			}

			//#region 覆盖宿主与探针
			/** 内联覆盖也写在 body 上（样式表规则之外的冗余保险）。 */
			function overrideHost() {
				return document.body || document.documentElement;
			}

			let probe = null;
			/** 惰性创建探针元素（1px、不可见、脱离布局）。 */
			function getProbe() {
				if (probe !== null && document.body && document.body.contains(probe)) return probe;
				probe = document.createElement("div");
				probe.setAttribute("aria-hidden", "true");
				probe.style.cssText =
					"position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
				if (document.body) document.body.appendChild(probe);
				return probe;
			}

			/** 把 token 挂到探针上，读浏览器解析后的颜色字符串。 */
			function resolveToken(token) {
				const el = getProbe();
				if (el === null) return null;
				el.style.backgroundColor = "";
				el.style.backgroundColor = "var(" + token + ")";
				const value = getComputedStyle(el).backgroundColor;
				el.style.backgroundColor = "";
				return value;
			}

			/** 解析 "rgb(r, g, b)" / "rgba(r, g, b, a)"；其它形态返回 null。 */
			function parseColor(value) {
				if (typeof value !== "string") return null;
				const match = /^rgba?\(([^)]+)\)$/.exec(value.trim());
				if (match === null) return null;
				const parts = match[1]
					.split(/[,\s/]+/)
					.filter((piece) => piece !== "")
					.map(Number);
				if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
				const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
				return { r: parts[0], g: parts[1], b: parts[2], a: alpha };
			}

			/** token 集合（去重）。 */
			function allTokens() {
				const seen = [];
				for (const group of GROUPS) {
					for (const token of group.tokens) if (seen.indexOf(token) < 0) seen.push(token);
				}
				return seen;
			}

			/** 规则文本按需拼；enabled=false 或未探测时返回空串（等于不写任何规则）。 */
			function buildRules() {
				if (!state.enabled || originals === null) return "";
				const declarations = [];
				let menuAlpha = null;
				for (const group of GROUPS) {
					const perToken = originals[group.key] || {};
					const alpha = typeof state[group.key] === "number" ? state[group.key] : group.def;
					if (group.restoreBacking) menuAlpha = alpha;
					for (const token of group.tokens) {
						const base = perToken[token];
						if (base === null || base === undefined) {
							written[token] = null;
							continue;
						}
						const value = formatColor(base, alpha);
						declarations.push(token + ": " + value + " !important;");
						written[token] = value;
					}
				}
				const parts = [];
				if (declarations.length > 0) parts.push(RULE_SELECTOR + " {" + declarations.join(" ") + "}");
				if (menuAlpha !== null && backingBase !== null) {
					parts.push(
						"[data-menu-backing] { background: " + formatColor(backingBase, menuAlpha) + " !important; }",
					);
				}
				return parts.join("\n");
			}

			/** 把规则写进受管样式表（没有就建一个；空串=移除）。 */
			function writeStyle(rules) {
				let tag = document.getElementById(STYLE_ID);
				if (rules === "") {
					if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag);
					return;
				}
				if (tag === null) {
					tag = document.createElement("style");
					tag.id = STYLE_ID;
					(document.head || document.documentElement).appendChild(tag);
				}
				tag.textContent = rules;
			}

			/** 移除本插件写入的全部覆盖（样式表 + 内联）。 */
			function clearOverrides() {
				writeStyle("");
				const host = overrideHost();
				for (const token of allTokens()) {
					try {
						host.style.removeProperty(token);
					} catch {
						/* ignore */
					}
				}
			}

			/** 清掉覆盖后读主题原色。 */
			function captureOriginals() {
				clearOverrides();
				const next = {};
				for (const group of GROUPS) {
					const perToken = {};
					for (const token of group.tokens) perToken[token] = parseColor(resolveToken(token));
					next[group.key] = perToken;
				}
				originals = next;
				backingBase = parseColor(resolveToken(BACKING_BASE_TOKEN));
			}

			function formatColor(base, alpha) {
				const a = Math.min(1, Math.max(0, alpha));
				return "rgba(" + base.r + ", " + base.g + ", " + base.b + ", " + Math.round(a * 1000) / 1000 + ")";
			}

			/** 写覆盖：样式表为主，内联为辅；写完再实测一次回读。 */
			function applyOverrides() {
				if (originals === null) return;
				writeStyle(buildRules());
				const host = overrideHost();
				if (state.enabled) {
					for (const token of allTokens()) {
						const value = written[token];
						if (value === null || value === undefined) continue;
						try {
							host.style.setProperty(token, value);
						} catch {
							/* ignore */
						}
					}
				} else {
					for (const token of allTokens()) {
						try {
							host.style.removeProperty(token);
						} catch {
							/* ignore */
						}
					}
				}
				// 实测：覆盖已在位，再探测一次读回真实生效值。
				for (const token of allTokens()) {
					measured[token] = resolveToken(token);
				}
			}

			/**
			 * 重新解析 + 重新写入。
			 *
			 * @param recapture - 主题/平台可能变了，需要重新读原色。
			 */
			function sync(recapture) {
				if (recapture || originals === null) captureOriginals();
				applyOverrides();
				emit();
			}
			//#endregion

			//#region 宿主设置读写
			/** 从宿主读设置；失败则保留默认值（插件仍然可用）。 */
			async function loadSettings() {
				try {
					const response = await fetch(SETTINGS_URL, { headers: { accept: "application/json" } });
					if (!response.ok) return;
					const payload = await response.json();
					if (payload === null || typeof payload !== "object") return;
					if (typeof payload.enabled === "boolean") state.enabled = payload.enabled;
					for (const group of GROUPS) {
						const value = Number(payload[group.key]);
						if (Number.isFinite(value)) state[group.key] = Math.min(1, Math.max(0, value));
					}
				} catch {
					/* 宿主路由不可达：用默认值继续 */
				}
			}

			let saveTimer = null;
			/** 防抖保存（滑块连续拖动只写最后一次）。 */
			function scheduleSave() {
				if (saveTimer !== null) clearTimeout(saveTimer);
				saveTimer = setTimeout(() => {
					saveTimer = null;
					try {
						fetch(SETTINGS_URL, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								enabled: state.enabled,
								menu: state.menu,
								overlay: state.overlay,
							}),
						}).catch(() => {});
					} catch {
						/* ignore */
					}
				}, 250);
			}

			/** 改一项设置：立即生效 + 排队持久化。 */
			function setValue(key, value) {
				state[key] = value;
				sync(false);
				scheduleSave();
			}

			/** 恢复出厂默认。 */
			function resetDefaults() {
				state.enabled = DEFAULTS.enabled;
				for (const group of GROUPS) state[group.key] = group.def;
				sync(false);
				scheduleSave();
			}
			//#endregion

			//#region 设置页 UI
			/** 订阅设置变更，返回当前快照。 */
			function useOverlayState() {
				const [, force] = React.useState(0);
				React.useEffect(() => {
					const listener = () => force((n) => n + 1);
					listeners.add(listener);
					return () => listeners.delete(listener);
				}, []);
				return state;
			}

			const styles = {
				group: { display: "flex", flexDirection: "column", gap: "10px", padding: "4px 2px" },
				title: { fontSize: "13px", fontWeight: 600 },
				hint: { fontSize: "11px", opacity: 0.65, lineHeight: 1.5 },
				row: { display: "flex", flexDirection: "column", gap: "6px" },
				rowHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px" },
				label: { fontSize: "12px" },
				value: { fontSize: "11px", opacity: 0.7, fontVariantNumeric: "tabular-nums" },
				slider: { width: "100%", accentColor: "var(--dsw-alias-brand-primary, #4f8cff)" },
				scale: { display: "flex", justifyContent: "space-between", fontSize: "10px", opacity: 0.5 },
				sub: { fontSize: "11px", opacity: 0.55 },
				code: { fontSize: "10px", opacity: 0.6, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
				actions: { display: "flex", gap: "8px", alignItems: "center" },
				button: {
					fontSize: "11px",
					padding: "3px 10px",
					borderRadius: "6px",
					border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))",
					background: "transparent",
					color: "inherit",
					cursor: "pointer",
				},
			};

			/** 一个滑块的完整行（含方向标注、写入值与实测值）。 */
			function GroupRow({ group }) {
				const current = useOverlayState();
				const percent = Math.round(current[group.key] * 100);
				return h(
					"div",
					{ style: styles.row },
					h(
						"div",
						{ style: styles.rowHead },
						h("span", { style: styles.label }, group.label),
						h("span", { style: styles.value }, percent + "%"),
					),
					h("input", {
						type: "range",
						min: 0,
						max: 100,
						step: 1,
						value: percent,
						disabled: !current.enabled,
						style: styles.slider,
						onChange: (event) => setValue(group.key, Number(event.target.value) / 100),
					}),
					h("div", { style: styles.scale }, h("span", null, "0% 全透"), h("span", null, "100% 实底")),
					h("span", { style: styles.sub }, group.hint),
					...group.tokens.map((token) =>
						h(
							"span",
							{ key: token, style: styles.code },
							token +
								"　写入 " +
								(written[token] === undefined || written[token] === null ? "—" : written[token]) +
								"　实测 " +
								(measured[token] === undefined || measured[token] === null ? "—" : measured[token]),
						),
					),
				);
			}

			/** 设置页里「浮层不透明度」那一行。 */
			function OverlayOpacityRow() {
				const current = useOverlayState();
				React.useEffect(() => {
					// 挂载时重新探测一次：此前可能已被别的插件改过主题变量。
					sync(true);
				}, []);
				return h(
					"div",
					{ style: styles.group },
					h(
						"div",
						{ style: styles.rowHead },
						h("span", { style: styles.title }, "浮层不透明度"),
						h(
							"label",
							{ style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px" } },
							h("input", {
								type: "checkbox",
								checked: current.enabled,
								onChange: (event) => setValue("enabled", event.target.checked),
							}),
							"启用",
						),
					),
					h(
						"span",
						{ style: styles.hint },
						"只改这几层底填充的 alpha，颜色仍完全跟随主题（含明暗切换）。macOS 上还会把菜单背板补回实色，让毛玻璃重新有底可采样。每行的「实测」是把覆盖挂上后回读的真实值，与「写入」不一致即说明覆盖没赢。",
					),
					...GROUPS.map((group) => h(GroupRow, { key: group.key, group })),
					h(
						"div",
						{ style: styles.actions },
						h(
							"button",
							{ type: "button", style: styles.button, onClick: resetDefaults },
							"恢复默认",
						),
						h(
							"span",
							{ style: styles.sub },
							current.enabled
								? "改动即时生效并保存到 ~/.dsh-overlay-opacity/config.json"
								: "已停用：变量已还原为宿主原值",
						),
					),
				);
			}

			/** 设置页分区容器。 */
			function OverlayOpacitySection({ renderSlot }) {
				// renderSlot 由宿主注入；契约若变化，直接渲染行本身，而不是整块消失。
				const body =
					typeof renderSlot === "function"
						? renderSlot("settings.overlayOpacity.item", {})
						: h(OverlayOpacityRow, {});
				return h("div", { style: { padding: "2px 0" } }, body);
			}
			//#endregion

			//#region 插件主体
			const inject = ["slots"];

			/**
			 * Client apply。
			 *
			 * @param ctx - client context（slots 由 inject 保证就绪）。
			 * @returns 卸载函数。
			 */
			function apply(ctx) {
				sync(true);

				// 主题 / 平台切换会换掉 token 的主题原色，必须重新探测。
				// 只监听主题相关属性，不监听 style —— 否则本插件写样式会触发自己，
				// 形成写-观察死循环。
				let observer = null;
				try {
					observer = new MutationObserver(() => sync(true));
					observer.observe(document.documentElement, {
						attributes: true,
						attributeFilter: ["data-platform", "class"],
					});
					if (document.body) {
						observer.observe(document.body, {
							attributes: true,
							attributeFilter: ["data-ds-dark-theme", "class", "data-we-wallpaper"],
						});
					}
				} catch {
					observer = null;
				}

				const disposers = [];
				if (observer !== null) {
					disposers.push(() => {
						try {
							observer.disconnect();
						} catch {
							/* ignore */
						}
					});
				}

				try {
					if (ctx && ctx.slots && typeof ctx.slots.inject === "function") {
						disposers.push(
							ctx.slots.inject("settings.section", () =>
								ctx.slots.register(
									{
										name: "settings.section",
										id: "overlay-opacity",
										order: 42,
										label: "浮层不透明度",
										children: { "settings.overlayOpacity.item": { kind: "list", scope: "root" } },
									},
									OverlayOpacitySection,
								),
							),
						);
						disposers.push(
							ctx.slots.inject("settings.overlayOpacity.item", () =>
								ctx.slots.register(
									{ name: "settings.overlayOpacity.item", id: "overlay-opacity", order: 42 },
									OverlayOpacityRow,
								),
							),
						);
					}
				} catch (err) {
					// 设置页注册失败时只损失 UI：token 覆盖已经生效，不影响主功能。
					try {
						console.warn("[dsh-overlay-opacity] settings section registration failed:", err);
					} catch {
						/* ignore */
					}
				}

				loadSettings().then(() => sync(false));

				return () => {
					for (const dispose of disposers) {
						try {
							dispose();
						} catch {
							/* ignore */
						}
					}
					clearOverrides();
					listeners.clear();
				};
			}

			exports.apply = apply;
			exports.inject = inject;
			return module.exports;
		},
	});
}
