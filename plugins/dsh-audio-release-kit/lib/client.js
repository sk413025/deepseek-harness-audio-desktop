window.__ModuleLoader__.load({
	id: "dsh-audio-release-kit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/locale.ts
		/** Copy for the release kit surfaces (namespace `audioReleaseKit`). */
		const NS = "audioReleaseKit";
		const en = {
			chipUseAudioMode: "Use audio mode",
			chipNewAudioConversation: "New audio conversation",
			chipHintBlank: "This audio model cannot call tools. Switch this new conversation to “DGX audio (no tools)”.",
			chipHintStarted: "This audio model cannot call tools. Start a new conversation in “DGX audio (no tools)” with the same workspace and model.",
			chipWorking: "Switching…",
			chipFailed: "Could not switch: {message}",
			cardTitle: "Audio servers",
			cardDescription: "OpenAI-compatible vLLM / vLLM-Omni audio servers used for voice questions and spoken replies.",
			expand: "Expand",
			collapse: "Collapse",
			emptyTitle: "No audio server yet",
			emptyBody: "Add the address of your vLLM or vLLM-Omni server. Nothing is contacted until you test it or send a message.",
			loading: "Reading audio servers…",
			unavailable: "The audio adapter is not installed in this deployment.",
			readOnly: "These settings are read-only in this deployment.",
			models: "Models",
			modeChat: "Voice question → text",
			modeChatSpeech: "Voice question → text + speech",
			modeTranscribe: "Transcription",
			modeRealtime: "Live (duplex)",
			keyless: "No API key",
			keyFrom: "API key from {name}",
			keyMissing: "API key {name} is not set",
			test: "Test connection",
			testing: "Testing…",
			testOk: "Reachable · {detail}",
			testFailed: "Not reachable: {message}",
			remove: "Remove",
			removeConfirm: "Remove {name}?",
			addTitle: "Add audio server",
			fieldName: "Name",
			fieldNamePlaceholder: "Lab speech server",
			fieldUrl: "Server address",
			fieldUrlHint: "Base URL ending in /v1. Pre-filled with the DGX Spark address; change it only for another server.",
			presets: "DGX Spark:",
			managedTitle: "From Audio models",
			managedBody: "These DGX Spark servers are set up by the Audio models page, which also switches the model on the DGX. Nothing to add here.",
			duplicateOfManaged: "This address is already provided by Audio models above; adding it here creates duplicate entries in the model picker.",
			libraryNoticeTitle: "{servers} is set up in Audio models",
			libraryNoticeBody: "Open Audio models in the sidebar and press Refresh: its models appear in the model picker with the right request settings, and Activate switches the model on the server. Add a server here only for a different server.",
			addManually: "Add a server manually",
			presetRequest: "Request settings added for this model: {values}",
			fieldModel: "Model",
			fieldModelHint: "The exact model name the server expects (pre-filled for the DGX Spark).",
			fieldMode: "Use",
			fieldSpeech: "Ask for spoken replies",
			fieldKeyEnv: "API key environment variable (optional)",
			fieldKeyEnvHint: "Leave empty for servers without authentication. Only the variable name is stored.",
			add: "Add server",
			saving: "Saving…",
			saved: "Saved. Pick the model in a conversation in “DGX audio (no tools)” mode.",
			saveFailed: "Could not save: {message}",
			invalidName: "Enter a name.",
			invalidUrl: "Enter an http:// or https:// address.",
			invalidModel: "Enter the model name.",
			capabilities: "Verified on this computer",
			capVerified: "verified",
			capUntested: "not tested yet",
			capAdvertised: "advertised by server, not tested",
			capDeclared: "declared, not tested",
			capUnsupported: "not supported",
			capTextStreaming: "streaming text",
			capAudioOutput: "spoken reply",
			capAudioOutputStreaming: "progressive speech",
			capLiveInput: "live input",
			capFullDuplex: "full duplex",
			capBargeIn: "interrupt"
		};
		const zh = {
			chipUseAudioMode: "使用音频模式",
			chipNewAudioConversation: "新建音频对话",
			chipHintBlank: "这个音频模型不能调用工具。将这个新对话切换为“DGX audio (no tools)”。",
			chipHintStarted: "这个音频模型不能调用工具。以相同工作区和模型新建一个“DGX audio (no tools)”对话。",
			chipWorking: "切换中…",
			chipFailed: "无法切换：{message}",
			cardTitle: "音频服务器",
			cardDescription: "用于语音提问和语音回复的 OpenAI 兼容 vLLM / vLLM-Omni 音频服务器。",
			expand: "展开",
			collapse: "收起",
			emptyTitle: "还没有音频服务器",
			emptyBody: "填写 vLLM 或 vLLM-Omni 服务器地址。在你测试或发送消息之前不会连接任何服务器。",
			loading: "正在读取音频服务器…",
			unavailable: "此部署未安装音频适配器。",
			readOnly: "此部署中的这些设置为只读。",
			models: "模型",
			modeChat: "语音提问 → 文字",
			modeChatSpeech: "语音提问 → 文字 + 语音",
			modeTranscribe: "转写",
			modeRealtime: "实时（双工）",
			keyless: "无需 API 密钥",
			keyFrom: "API 密钥来自 {name}",
			keyMissing: "未设置 API 密钥 {name}",
			test: "测试连接",
			testing: "测试中…",
			testOk: "可连接 · {detail}",
			testFailed: "无法连接：{message}",
			remove: "移除",
			removeConfirm: "移除 {name}？",
			addTitle: "添加音频服务器",
			fieldName: "名称",
			fieldNamePlaceholder: "实验室语音服务器",
			fieldUrl: "服务器地址",
			fieldUrlHint: "以 /v1 结尾的 Base URL。已预填 DGX Spark 地址；只有连接其他服务器时才需要修改。",
			presets: "DGX Spark：",
			managedTitle: "来自“音频模型”",
			managedBody: "这些 DGX Spark 服务器已由“音频模型”页面配置，该页面也会切换 DGX 上的模型。这里无需再添加。",
			duplicateOfManaged: "上方“音频模型”已提供这个地址；在这里再添加会让模型选择器出现重复项。",
			libraryNoticeTitle: "{servers} 已在“音频模型”中配置",
			libraryNoticeBody: "打开侧边栏的“音频模型”并按“刷新”：它的模型会以正确的请求设置出现在模型选择器中，按“启用”会在服务器上切换模型。只有连接其他服务器时才在这里添加。",
			addManually: "手动添加服务器",
			presetRequest: "会为此模型加入请求设置：{values}",
			fieldModel: "模型",
			fieldModelHint: "服务器使用的准确模型名称（已为 DGX Spark 预填）。",
			fieldMode: "用途",
			fieldSpeech: "请求语音回复",
			fieldKeyEnv: "API 密钥环境变量（可选）",
			fieldKeyEnvHint: "无需认证的服务器留空即可。只保存变量名称。",
			add: "添加服务器",
			saving: "保存中…",
			saved: "已保存。在“DGX audio (no tools)”模式的对话中选择该模型。",
			saveFailed: "无法保存：{message}",
			invalidName: "请输入名称。",
			invalidUrl: "请输入 http:// 或 https:// 地址。",
			invalidModel: "请输入模型名称。",
			capabilities: "已在本机验证",
			capVerified: "已验证",
			capUntested: "尚未测试",
			capAdvertised: "服务器声明，未测试",
			capDeclared: "配置声明，未测试",
			capUnsupported: "不支持",
			capTextStreaming: "流式文字",
			capAudioOutput: "语音回复",
			capAudioOutputStreaming: "渐进式语音",
			capLiveInput: "实时输入",
			capFullDuplex: "全双工",
			capBargeIn: "打断"
		};
		/** Replace `{name}` placeholders. */
		function format(text, values = {}) {
			return text.replaceAll(/\{([^{}]+)\}/gu, (placeholder, key) => values[key] ?? placeholder);
		}
		//#endregion
		//#region \0dsh-css:packages/third-party/dsh-audio-release-kit/src/client/kit.module.css.mjs
		const css = "._2wzUyW_chipWrap{align-items:center;gap:8px;min-width:0;display:inline-flex}._2wzUyW_chip{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:28px;color:var(--dsw-alias-label-primary);font:inherit;white-space:nowrap;cursor:pointer;border-radius:999px;align-items:center;gap:6px;padding:0 10px;font-size:12px;display:inline-flex}._2wzUyW_chip:hover{border-color:var(--dsw-alias-label-dimmed)}._2wzUyW_chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}._2wzUyW_chip:disabled{opacity:.6;cursor:progress}._2wzUyW_chipDot{background:var(--dsw-alias-brand-primary);border-radius:50%;width:6px;height:6px}._2wzUyW_chipError{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;max-width:240px;font-size:12px;overflow:hidden}._2wzUyW_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}._2wzUyW_card:hover{border-color:var(--dsw-alias-label-dimmed)}._2wzUyW_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}._2wzUyW_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}._2wzUyW_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}._2wzUyW_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}._2wzUyW_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}._2wzUyW_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}._2wzUyW_count{border:.5px solid var(--dsw-alias-border-l4);text-align:center;min-width:22px;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 7px;font-size:12px}._2wzUyW_chevron{color:var(--dsw-alias-label-tertiary);flex:none;line-height:1;transition:transform .16s}._2wzUyW_chevronOpen{transform:rotate(180deg)}._2wzUyW_body{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:14px;margin:0 16px;padding:12px 0 14px;display:flex}._2wzUyW_muted{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:1.5}._2wzUyW_empty{border:.5px dashed var(--dsw-alias-border-l4);border-radius:12px;padding:12px 14px}._2wzUyW_emptyTitle{color:var(--dsw-alias-label-primary);margin:0 0 4px;font-size:14px;font-weight:600}._2wzUyW_routes{flex-direction:column;gap:10px;margin:0;padding:0;list-style:none;display:flex}._2wzUyW_route{background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:8px;padding:12px 14px;display:flex}._2wzUyW_routeHead{flex-wrap:wrap;align-items:baseline;gap:8px 12px;display:flex}._2wzUyW_routeName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600}._2wzUyW_routeUrl{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-size:12px}._2wzUyW_routeMeta{color:var(--dsw-alias-label-tertiary);font-size:12px}._2wzUyW_modelList{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}._2wzUyW_modelRow{flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:13px;display:flex}._2wzUyW_modelName{color:var(--dsw-alias-label-primary)}._2wzUyW_pill{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));border-radius:999px;padding:1px 8px;font-size:12px}._2wzUyW_caps{flex-wrap:wrap;gap:4px 10px;display:flex}._2wzUyW_cap{color:var(--dsw-alias-label-tertiary);font-size:12px}._2wzUyW_capVerified{color:var(--dsw-alias-label-primary)}._2wzUyW_routeActions{flex-wrap:wrap;align-items:center;gap:8px 10px;display:flex}._2wzUyW_primary,._2wzUyW_secondary,._2wzUyW_ghost{height:32px;font:inherit;white-space:nowrap;cursor:pointer;border-radius:16px;justify-content:center;align-items:center;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex}._2wzUyW_primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:0}._2wzUyW_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}._2wzUyW_secondary{border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:0 0}._2wzUyW_secondary:hover:not(:disabled),._2wzUyW_ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}._2wzUyW_ghost{color:var(--dsw-alias-label-tertiary);background:0 0;border:0}._2wzUyW_primary:disabled,._2wzUyW_secondary:disabled,._2wzUyW_ghost:disabled{opacity:.4;cursor:not-allowed}._2wzUyW_primary:focus-visible,._2wzUyW_secondary:focus-visible,._2wzUyW_ghost:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}._2wzUyW_ok{color:var(--dsw-alias-label-primary);font-size:12px}._2wzUyW_bad{color:var(--dsw-alias-label-error,var(--dsw-alias-label-tertiary));overflow-wrap:anywhere;font-size:12px}._2wzUyW_form{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:12px;display:flex}._2wzUyW_formTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:14px;font-weight:600}._2wzUyW_row{flex-wrap:wrap;align-items:flex-end;gap:12px;display:flex}._2wzUyW_field{flex-direction:column;gap:4px;min-width:0;display:flex}._2wzUyW_row ._2wzUyW_field{flex:220px}._2wzUyW_label{color:var(--dsw-alias-label-primary);font-size:13px}._2wzUyW_hint{color:var(--dsw-alias-label-tertiary);font-size:12px}._2wzUyW_input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-2));height:32px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;min-width:0;padding:0 10px;font-size:13px}._2wzUyW_input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0}._2wzUyW_check{height:32px;color:var(--dsw-alias-label-primary);align-items:center;gap:6px;font-size:13px;display:inline-flex}._2wzUyW_footer{justify-content:space-between;align-items:center;gap:12px;display:flex}";
		const tagId = "dsh-audio-release-kit/kit.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-audio-release-kit";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var kit_module_css_default = {
			"bad": "_2wzUyW_bad",
			"body": "_2wzUyW_body",
			"cap": "_2wzUyW_cap",
			"capVerified": "_2wzUyW_capVerified",
			"caps": "_2wzUyW_caps",
			"card": "_2wzUyW_card",
			"cardOpen": "_2wzUyW_cardOpen",
			"check": "_2wzUyW_check",
			"chevron": "_2wzUyW_chevron",
			"chevronOpen": "_2wzUyW_chevronOpen",
			"chip": "_2wzUyW_chip",
			"chipDot": "_2wzUyW_chipDot",
			"chipError": "_2wzUyW_chipError",
			"chipWrap": "_2wzUyW_chipWrap",
			"count": "_2wzUyW_count",
			"description": "_2wzUyW_description",
			"empty": "_2wzUyW_empty",
			"emptyTitle": "_2wzUyW_emptyTitle",
			"field": "_2wzUyW_field",
			"footer": "_2wzUyW_footer",
			"form": "_2wzUyW_form",
			"formTitle": "_2wzUyW_formTitle",
			"ghost": "_2wzUyW_ghost",
			"headText": "_2wzUyW_headText",
			"header": "_2wzUyW_header",
			"hint": "_2wzUyW_hint",
			"input": "_2wzUyW_input",
			"label": "_2wzUyW_label",
			"modelList": "_2wzUyW_modelList",
			"modelName": "_2wzUyW_modelName",
			"modelRow": "_2wzUyW_modelRow",
			"muted": "_2wzUyW_muted",
			"name": "_2wzUyW_name",
			"ok": "_2wzUyW_ok",
			"pill": "_2wzUyW_pill",
			"primary": "_2wzUyW_primary",
			"route": "_2wzUyW_route",
			"routeActions": "_2wzUyW_routeActions",
			"routeHead": "_2wzUyW_routeHead",
			"routeMeta": "_2wzUyW_routeMeta",
			"routeName": "_2wzUyW_routeName",
			"routeUrl": "_2wzUyW_routeUrl",
			"routes": "_2wzUyW_routes",
			"row": "_2wzUyW_row",
			"secondary": "_2wzUyW_secondary"
		};
		//#endregion
		//#region src/client/AudioModeChip.tsx
		/**
		* Composer chip for the `conversation.input.left` slot: shown only when the session's selected model belongs to
		* the audio adapter while the session is not in the "DGX audio (no tools)" preset. Upstream refuses a preset
		* switch once a session has history, so a started session gets a new conversation in the same workspace with the
		* same model; a blank session is switched in place. Normal sessions (non-audio models) render nothing.
		*/
		const AUDIO_PRESET_ID = "dgx-audio";
		function AudioModeChip(props) {
			const t = (key, values) => format(props.t(key), values);
			const store = props.audioRoutes;
			const actions = props.audioModeActions;
			const routes = (0, react.useSyncExternalStore)(store.subscribe, store.getSnapshot);
			const preset = props.useProjection("agentPreset");
			const selection = props.useProjection("modelSelection", (value) => value?.next ?? value?.lastUsed ?? null);
			const blank = props.useSessions((state) => state.byId?.[props.sessionId]?.blank === true);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			if (!(selection !== null && routes.routes.some((route) => route.provider === selection.provider)) || preset === "dgx-audio" || preset === void 0) return null;
			const label = blank ? t("chipUseAudioMode") : t("chipNewAudioConversation");
			const hint = blank ? t("chipHintBlank") : t("chipHintStarted");
			const run = async () => {
				setBusy(true);
				setError(null);
				try {
					if (blank) await actions.switchBlank(props.sessionId);
					else await actions.startAudioConversation(props.sessionId, selection.provider, selection.model);
				} catch (reason) {
					setError(t("chipFailed", { message: reason instanceof Error ? reason.message : String(reason) }));
				} finally {
					setBusy(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: kit_module_css_default.chipWrap,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: kit_module_css_default.chip,
					"data-testid": "dsh-audio-mode-chip",
					title: hint,
					"aria-label": `${label}. ${hint}`,
					disabled: busy,
					onClick: () => {
						run();
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: kit_module_css_default.chipDot,
						"aria-hidden": "true"
					}), busy ? t("chipWorking") : label]
				}), error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: kit_module_css_default.chipError,
					role: "status",
					children: error
				}) : null]
			});
		}
		//#endregion
		//#region src/client/audio-routes.ts
		const CAPABILITIES_PATH = "/api/dsh-dgx-audio/v1/capabilities";
		/** A tiny external store so every chip and the settings card share one fetch. */
		var AudioRoutesStore = class {
			snapshot = {
				status: "loading",
				configured: false,
				routes: []
			};
			listeners = /* @__PURE__ */ new Set();
			inflight;
			disposed = false;
			getSnapshot = () => this.snapshot;
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			dispose() {
				this.disposed = true;
				this.listeners.clear();
			}
			/** Re-read the capability document (after settings changes, probes or reconnects). */
			refresh() {
				if (this.inflight !== void 0) return this.inflight;
				this.inflight = this.load().finally(() => {
					this.inflight = void 0;
				});
				return this.inflight;
			}
			/** Providers whose models belong to the audio adapter. */
			providers() {
				return new Set(this.snapshot.routes.map((route) => route.provider));
			}
			publish(next) {
				if (this.disposed) return;
				this.snapshot = next;
				for (const listener of this.listeners) listener();
			}
			async load() {
				try {
					const response = await fetch(CAPABILITIES_PATH, { credentials: "include" });
					if (response.status === 404) {
						this.publish({
							status: "absent",
							configured: false,
							routes: []
						});
						return;
					}
					if (!response.ok) {
						this.publish({
							status: "error",
							configured: false,
							routes: this.snapshot.routes,
							message: `HTTP ${response.status}`
						});
						return;
					}
					const body = await response.json();
					this.publish({
						status: "ready",
						configured: body.configured === true,
						routes: Array.isArray(body.routes) ? body.routes : []
					});
				} catch (error) {
					this.publish({
						status: "error",
						configured: false,
						routes: this.snapshot.routes,
						message: error instanceof Error ? error.message : String(error)
					});
				}
			}
		};
		/** Explicit, user-initiated reachability check (`GET {baseURL}/models` on the host; no inference). */
		async function probeReachability(provider, model) {
			try {
				const response = await fetch(`${CAPABILITIES_PATH}/probe`, {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						provider,
						model,
						checks: ["reachability"]
					})
				});
				const body = await response.json().catch(() => void 0);
				if (!response.ok || body?.ok === false) return {
					ok: false,
					message: body?.error?.message ?? body?.error?.code ?? `HTTP ${response.status}`
				};
				const reach = body?.probe?.reachability;
				if (reach?.ok !== true) return {
					ok: false,
					message: reach?.error?.message ?? (reach?.status !== void 0 ? `HTTP ${reach.status}` : "unreachable")
				};
				return {
					ok: true,
					message: `${reach.ms ?? "?"} ms${reach.modelListed === false ? " · model not listed by the server" : ""}`
				};
			} catch (error) {
				return {
					ok: false,
					message: error instanceof Error ? error.message : String(error)
				};
			}
		}
		//#endregion
		//#region src/client/presets.ts
		const SERVER_PRESETS = [{
			key: "minicpm",
			label: "MiniCPM-o 4.5",
			name: "DGX Spark · MiniCPM-o 4.5",
			url: "http://100.83.70.119:18124/v1",
			model: "openbmb/MiniCPM-o-4_5",
			entry: {
				id: "minicpmo45-s2s",
				name: "MiniCPM-o 4.5 · voice/mic question → text + spoken reply",
				request: { extraBody: { chat_template_kwargs: {
					enable_thinking: false,
					use_tts_template: true
				} } }
			}
		}, {
			key: "mimo",
			label: "MiMo-Audio-7B-Instruct",
			name: "DGX Spark · MiMo-Audio-7B-Instruct",
			url: "http://100.83.70.119:18212/v1",
			model: "XiaomiMiMo/MiMo-Audio-7B-Instruct",
			entry: {
				id: "mimo-audio-s2s",
				name: "MiMo-Audio-7B-Instruct · mic record → text + spoken reply",
				request: {
					maxTokens: 200,
					systemPrompt: "You are a helpful voice assistant. Answer the user's spoken question briefly.",
					systemPromptWithAudio: "system"
				}
			}
		}];
		/** Form values for a preset. */
		function presetForm(preset) {
			return {
				name: preset.name,
				url: preset.url,
				model: preset.model,
				mode: "chat",
				speech: true,
				keyEnv: ""
			};
		}
		/** The preset whose model id equals `model` (trimmed, exact). */
		function presetForModel(model) {
			return SERVER_PRESETS.find((preset) => preset.model === model.trim());
		}
		function slug(text) {
			const base = text.normalize("NFKD").toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-+|-+$/gu, "").slice(0, 32);
			return base === "" ? "audio-server" : base;
		}
		/**
		* Model entry written for the form. A chat entry for a preset model gets the preset id, display name and request values;
		* a transcription entry or any other model gets the generic entry.
		*/
		function modelEntry(form) {
			const model = form.model.trim();
			const preset = form.mode === "chat" ? presetForModel(model) : void 0;
			if (preset !== void 0) return {
				id: preset.entry.id,
				name: preset.entry.name,
				upstreamModel: model,
				mode: "chat",
				sendModalities: true,
				outputAudio: form.speech,
				...preset.entry.request
			};
			return {
				id: `${slug(model.split("/").at(-1) ?? model)}${form.mode === "transcribe" ? "-transcribe" : ""}`,
				name: model,
				upstreamModel: model,
				mode: form.mode,
				...form.mode === "chat" ? {
					sendModalities: true,
					outputAudio: form.speech
				} : {}
			};
		}
		//#endregion
		//#region src/client/AudioServersCard.tsx
		/**
		* Settings → Plugins card for the `dsh-dgx-audio` namespace: first-run server setup and a truthful view of what
		* each configured model has actually been verified to do on this computer. Nothing is contacted automatically;
		* "Test connection" is an explicit user action that asks the host for a reachability probe (no inference).
		*/
		const sameUrl = (a, b) => a.trim().replace(/\/+$/u, "") === b.trim().replace(/\/+$/u, "");
		function capLabel(t, cap) {
			switch (cap?.state) {
				case "verified": return t("capVerified");
				case "advertised": return t("capAdvertised");
				case "declared": return t("capDeclared");
				case "unsupported": return t("capUnsupported");
				default: return t("capUntested");
			}
		}
		const CAP_LABEL = {
			textStreaming: "capTextStreaming",
			audioOutput: "capAudioOutput",
			audioOutputStreaming: "capAudioOutputStreaming",
			liveInput: "capLiveInput",
			fullDuplex: "capFullDuplex",
			bargeIn: "capBargeIn"
		};
		/** Only the capabilities that mean something for this model's mode. */
		function capabilityKeys(model) {
			if (model.mode === "realtime") return [
				"liveInput",
				"fullDuplex",
				"bargeIn"
			];
			if (model.mode === "transcribe") return [];
			return model.output?.audio === true ? [
				"textStreaming",
				"audioOutput",
				"audioOutputStreaming"
			] : ["textStreaming"];
		}
		function modeLabel(t, model) {
			if (model.mode === "transcribe") return t("modeTranscribe");
			if (model.mode === "realtime") return t("modeRealtime");
			return model.output?.audio === true ? t("modeChatSpeech") : t("modeChat");
		}
		function AudioServersCard(props) {
			const t = (key, values) => format(props.t(key), values);
			const face = props.audioServers;
			const settings = (0, react.useSyncExternalStore)(face.scope.subscribe, face.scope.getSnapshot);
			const live = (0, react.useSyncExternalStore)(face.routes.subscribe, face.routes.getSnapshot);
			const [open, setOpen] = (0, react.useState)(false);
			const [probe, setProbe] = (0, react.useState)({});
			const [form, setForm] = (0, react.useState)(() => presetForm(SERVER_PRESETS[0]));
			const [status, setStatus] = (0, react.useState)("");
			const [saving, setSaving] = (0, react.useState)(false);
			const [libraryServers, setLibraryServers] = (0, react.useState)([]);
			const [manual, setManual] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				face.routes.refresh();
			}, [settings]);
			(0, react.useEffect)(() => {
				if (!open) return;
				let cancelled = false;
				fetch("/api/dsh-audio-model-library/v1/library", { credentials: "include" }).then((response) => response.ok ? response.json() : null).then((body) => {
					if (!cancelled) setLibraryServers((body?.servers ?? []).map((server) => server.displayName ?? server.id ?? "").filter((name) => name !== ""));
				}).catch(() => {
					if (!cancelled) setLibraryServers([]);
				});
				return () => {
					cancelled = true;
				};
			}, [open]);
			if (settings.status === "unavailable") return null;
			const configured = Array.isArray(settings.value?.routes) ? settings.value.routes : [];
			const liveByProvider = new Map(live.routes.map((route) => [route.provider, route]));
			const managed = live.routes.filter((route) => !configured.some((own) => own.provider === route.provider));
			const writable = settings.writable;
			const nextPreset = (routes) => SERVER_PRESETS.find((preset) => !routes.some((route) => sameUrl(route.baseURL, preset.url) && route.models.some((model) => model.upstreamModel === preset.model))) ?? SERVER_PRESETS[0];
			const formPreset = form.mode === "chat" ? presetForModel(form.model) : void 0;
			const showForm = libraryServers.length === 0 || manual;
			const duplicateOfManaged = managed.some((route) => sameUrl(route.baseURL, form.url));
			const write = async (routes, done) => {
				setSaving(true);
				setStatus(t("saving"));
				try {
					await face.scope.mutate([{
						op: "set",
						path: ["routes"],
						value: routes
					}]);
					await face.routes.refresh();
					setStatus(done);
					return true;
				} catch (error) {
					setStatus(t("saveFailed", { message: error instanceof Error ? error.message : String(error) }));
					return false;
				} finally {
					setSaving(false);
				}
			};
			const add = async () => {
				const name = form.name.trim();
				const url = form.url.trim().replace(/\/+$/u, "");
				const model = form.model.trim();
				if (name === "") {
					setStatus(t("invalidName"));
					return;
				}
				if (!/^https?:\/\/[^\s/]+/u.test(url)) {
					setStatus(t("invalidUrl"));
					return;
				}
				if (model === "") {
					setStatus(t("invalidModel"));
					return;
				}
				const taken = new Set(configured.map((route) => route.provider));
				let provider = slug(name);
				for (let n = 2; taken.has(provider); n++) provider = `${slug(name)}-${n}`;
				const route = {
					provider,
					displayName: name,
					baseURL: url,
					...form.keyEnv.trim() === "" ? {} : { apiKeyEnv: form.keyEnv.trim() },
					models: [modelEntry(form)]
				};
				const routes = [...configured, route];
				if (await write(routes, t("saved"))) setForm(presetForm(nextPreset(routes)));
			};
			const remove = async (provider, name) => {
				if (!window.confirm(t("removeConfirm", { name }))) return;
				await write(configured.filter((route) => route.provider !== provider), "");
			};
			const test = async (provider, model) => {
				setProbe((current) => ({
					...current,
					[provider]: "running"
				}));
				const result = await probeReachability(provider, model);
				setProbe((current) => ({
					...current,
					[provider]: result
				}));
				face.routes.refresh();
			};
			const title = t("cardTitle");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: `${kit_module_css_default.card} ${open ? kit_module_css_default.cardOpen : ""}`,
				"data-testid": "dsh-audio-servers-card",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: kit_module_css_default.header,
					"aria-expanded": open,
					"aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: kit_module_css_default.headText,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: kit_module_css_default.name,
								children: title
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: kit_module_css_default.description,
								children: t("cardDescription")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: kit_module_css_default.count,
							children: configured.length
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: `${kit_module_css_default.chevron} ${open ? kit_module_css_default.chevronOpen : ""}`,
							"aria-hidden": "true",
							children: "⌄"
						})
					]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: kit_module_css_default.body,
					children: [
						settings.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: kit_module_css_default.muted,
							children: t("loading")
						}) : null,
						!writable && settings.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: kit_module_css_default.muted,
							role: "status",
							children: t("readOnly")
						}) : null,
						managed.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-testid": "dsh-audio-servers-managed",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: kit_module_css_default.formTitle,
									children: t("managedTitle")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: kit_module_css_default.muted,
									children: t("managedBody")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
									className: kit_module_css_default.routes,
									children: managed.map((route) => {
										const firstModel = String(route.models[0]?.id ?? "");
										const result = probe[route.provider];
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
											className: kit_module_css_default.route,
											"data-testid": "dsh-audio-server-managed-row",
											"data-provider": route.provider,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: kit_module_css_default.routeHead,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: kit_module_css_default.routeName,
														children: route.displayName ?? route.provider
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
														className: kit_module_css_default.routeUrl,
														children: route.baseURL
													})]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
													className: kit_module_css_default.modelList,
													"aria-label": t("models"),
													children: route.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
														className: kit_module_css_default.modelRow,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: kit_module_css_default.modelName,
															children: model.name ?? model.id
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: kit_module_css_default.pill,
															children: modeLabel(t, model)
														})]
													}, model.id))
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: kit_module_css_default.routeActions,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: kit_module_css_default.secondary,
														disabled: result === "running" || firstModel === "",
														onClick: () => {
															test(route.provider, firstModel);
														},
														children: result === "running" ? t("testing") : t("test")
													}), result !== void 0 && result !== "running" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														role: "status",
														className: result.ok ? kit_module_css_default.ok : kit_module_css_default.bad,
														children: result.ok ? t("testOk", { detail: result.message }) : t("testFailed", { message: result.message })
													}) : null]
												})
											]
										}, route.provider);
									})
								})
							]
						}) : null,
						configured.length === 0 && managed.length === 0 && settings.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: kit_module_css_default.empty,
							"data-testid": "dsh-audio-servers-empty",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: kit_module_css_default.emptyTitle,
								children: t("emptyTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: kit_module_css_default.muted,
								children: t("emptyBody")
							})]
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: kit_module_css_default.routes,
							children: configured.map((route) => {
								const view = liveByProvider.get(route.provider);
								const firstModel = String(route.models?.[0]?.id ?? "");
								const result = probe[route.provider];
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: kit_module_css_default.route,
									"data-testid": "dsh-audio-server-row",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: kit_module_css_default.routeHead,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: kit_module_css_default.routeName,
												children: route.displayName ?? route.provider
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
												className: kit_module_css_default.routeUrl,
												children: route.baseURL
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: kit_module_css_default.routeMeta,
											children: view?.authentication === "none" || route.apiKeyEnv === void 0 ? t("keyless") : view?.credentialPresent === false ? t("keyMissing", { name: route.apiKeyEnv }) : t("keyFrom", { name: route.apiKeyEnv })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
											className: kit_module_css_default.modelList,
											"aria-label": t("models"),
											children: (view?.models ?? []).map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
												className: kit_module_css_default.modelRow,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: kit_module_css_default.modelName,
														children: model.name ?? model.id
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: kit_module_css_default.pill,
														children: modeLabel(t, model)
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: kit_module_css_default.caps,
														children: capabilityKeys(model).filter((key) => model.capabilities?.[key]?.state !== "unsupported").map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: `${kit_module_css_default.cap} ${model.capabilities?.[key]?.state === "verified" ? kit_module_css_default.capVerified : ""}`,
															children: [
																t(CAP_LABEL[key]),
																": ",
																capLabel(t, model.capabilities?.[key])
															]
														}, key))
													})
												]
											}, model.id))
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: kit_module_css_default.routeActions,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: kit_module_css_default.secondary,
													disabled: result === "running" || firstModel === "",
													onClick: () => {
														test(route.provider, firstModel);
													},
													"data-testid": "dsh-audio-server-test",
													children: result === "running" ? t("testing") : t("test")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: kit_module_css_default.ghost,
													disabled: !writable || saving,
													onClick: () => {
														remove(route.provider, route.displayName ?? route.provider);
													},
													children: t("remove")
												}),
												result !== void 0 && result !== "running" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													role: "status",
													className: result.ok ? kit_module_css_default.ok : kit_module_css_default.bad,
													children: result.ok ? t("testOk", { detail: result.message }) : t("testFailed", { message: result.message })
												}) : null
											]
										})
									]
								}, route.provider);
							})
						}),
						libraryServers.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: kit_module_css_default.empty,
							"data-testid": "dsh-audio-servers-library-notice",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: kit_module_css_default.emptyTitle,
									children: t("libraryNoticeTitle", { servers: libraryServers.join(", ") })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: kit_module_css_default.muted,
									children: t("libraryNoticeBody")
								}),
								!manual ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: kit_module_css_default.ghost,
									onClick: () => {
										setManual(true);
									},
									"data-testid": "dsh-audio-server-manual",
									children: t("addManually")
								}) : null
							]
						}) : null,
						showForm ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
							className: kit_module_css_default.form,
							onSubmit: (event) => {
								event.preventDefault();
								add();
							},
							"data-testid": "dsh-audio-server-form",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: kit_module_css_default.formTitle,
									children: t("addTitle")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: kit_module_css_default.row,
									"data-testid": "dsh-audio-server-presets",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: kit_module_css_default.label,
										children: t("presets")
									}), SERVER_PRESETS.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: kit_module_css_default.ghost,
										disabled: !writable,
										"data-preset": preset.key,
										onClick: () => {
											setForm(presetForm(preset));
										},
										children: preset.label
									}, preset.key))]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: kit_module_css_default.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: kit_module_css_default.label,
										children: t("fieldName")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: kit_module_css_default.input,
										value: form.name,
										placeholder: t("fieldNamePlaceholder"),
										disabled: !writable,
										onChange: (event) => {
											setForm({
												...form,
												name: event.target.value
											});
										}
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: kit_module_css_default.field,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: kit_module_css_default.label,
											children: t("fieldUrl")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: kit_module_css_default.input,
											value: form.url,
											placeholder: "http://100.83.70.119:18124/v1",
											inputMode: "url",
											disabled: !writable,
											"data-testid": "dsh-audio-server-url",
											onChange: (event) => {
												setForm({
													...form,
													url: event.target.value
												});
											}
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: kit_module_css_default.hint,
											children: duplicateOfManaged ? t("duplicateOfManaged") : t("fieldUrlHint")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: kit_module_css_default.field,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: kit_module_css_default.label,
											children: t("fieldModel")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: kit_module_css_default.input,
											value: form.model,
											disabled: !writable,
											"data-testid": "dsh-audio-server-model",
											onChange: (event) => {
												setForm({
													...form,
													model: event.target.value
												});
											}
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: kit_module_css_default.hint,
											"data-testid": "dsh-audio-server-preset-request",
											children: formPreset !== void 0 ? t("presetRequest", { values: Object.entries(formPreset.entry.request).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ") }) : t("fieldModelHint")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: kit_module_css_default.row,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: kit_module_css_default.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: kit_module_css_default.label,
											children: t("fieldMode")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
											className: kit_module_css_default.input,
											value: form.mode,
											disabled: !writable,
											onChange: (event) => {
												setForm({
													...form,
													mode: event.target.value
												});
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "chat",
												children: t("modeChat")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "transcribe",
												children: t("modeTranscribe")
											})]
										})]
									}), form.mode === "chat" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: kit_module_css_default.check,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: form.speech,
											disabled: !writable,
											onChange: (event) => {
												setForm({
													...form,
													speech: event.target.checked
												});
											}
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("fieldSpeech") })]
									}) : null]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: kit_module_css_default.field,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: kit_module_css_default.label,
											children: t("fieldKeyEnv")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: kit_module_css_default.input,
											value: form.keyEnv,
											placeholder: "LAB_AUDIO_API_KEY",
											disabled: !writable,
											onChange: (event) => {
												setForm({
													...form,
													keyEnv: event.target.value
												});
											}
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: kit_module_css_default.hint,
											children: t("fieldKeyEnvHint")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: kit_module_css_default.footer,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										role: "status",
										className: kit_module_css_default.muted,
										"data-testid": "dsh-audio-servers-status",
										children: status
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "submit",
										className: kit_module_css_default.primary,
										disabled: !writable || saving,
										children: saving ? t("saving") : t("add")
									})]
								})
							]
						}) : null
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser half of dsh-audio-release-kit (shared by Web and Desktop):
		* - `settings.plugin.item` card keyed `dsh-dgx-audio`: first-run audio server setup + explicit connection test;
		* - `conversation.input.left` chip: when an audio-adapter model is selected outside the no-tools audio preset,
		*   switch a blank session in place or start a new audio conversation in the same workspace with the same model.
		*/
		const SETTINGS_NS = "dsh-dgx-audio";
		function workspacePathOf(ctx, sessionId) {
			const item = ctx.workspaces.list.getSnapshot().items?.find((entry) => entry.sessionIds?.includes(sessionId));
			return typeof item?.path === "string" ? item.path : void 0;
		}
		const inject = [
			"slots",
			"locale",
			"settingsScope",
			"sessions",
			"workspaces",
			"uiWorkspace",
			"remote",
			"remote.agentPresets",
			"remote.session"
		];
		function unwrap(result, what) {
			if (!result.ok) throw new Error(`${what}: ${result.error?.message ?? result.error?.code ?? "failed"}`);
			return result.value;
		}
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				en,
				zh
			}), "audio-release-kit: dictionaries");
			const routes = new AudioRoutesStore();
			routes.refresh();
			ctx.effect(() => () => {
				routes.dispose();
			}, "audio-release-kit: routes store");
			ctx.effect(() => ctx.remote.$on("settings/document-updated", () => {
				routes.refresh();
			}), "audio-release-kit: settings refresh");
			ctx.effect(() => ctx.remote.$on("llm/adapters-updated", () => {
				routes.refresh();
			}), "audio-release-kit: adapter refresh");
			ctx.effect(() => ctx.on("connection/reset", () => {
				routes.refresh();
			}), "audio-release-kit: reconnect refresh");
			const actions = {
				async switchBlank(sessionId) {
					unwrap(await ctx.remote.agentPresets.select(sessionId, AUDIO_PRESET_ID), "select preset");
				},
				async startAudioConversation(sessionId, provider, model) {
					const workspace = ctx.workspaces.list.getSnapshot().items?.find((item) => item.sessionIds?.includes(sessionId));
					const summary = ctx.sessions.list.getSnapshot().byId?.[sessionId];
					let created;
					if (workspace !== void 0) {
						created = await ctx.sessions.create({ workspaceId: workspace.workspaceId });
						unwrap(await ctx.remote.agentPresets.select(created, AUDIO_PRESET_ID), "select preset");
					} else {
						const cwd = summary?.cwd ?? workspacePathOf(ctx, sessionId);
						created = unwrap(await ctx.remote.session.create({
							...cwd !== void 0 ? { cwd } : {},
							agentPreset: AUDIO_PRESET_ID
						}), "create session").sessionId;
						await ctx.sessions.refresh();
					}
					unwrap(await ctx.remote.session.selectModel({
						sessionId: created,
						provider,
						model
					}), "select model");
					ctx.uiWorkspace.openSession(created);
				}
			};
			const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
			const serversFace = {
				scope: {
					getSnapshot: () => scope.getSnapshot(),
					subscribe: (listener) => scope.subscribe(listener),
					mutate: (ops) => scope.mutate(ops)
				},
				routes
			};
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: SETTINGS_NS,
				locale: NS,
				inject: () => ({ audioServers: serversFace })
			}, AudioServersCard));
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "dsh-audio-mode-chip",
				order: 90,
				locale: NS,
				inject: () => ({
					audioRoutes: routes,
					audioModeActions: actions
				})
			}, AudioModeChip));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map