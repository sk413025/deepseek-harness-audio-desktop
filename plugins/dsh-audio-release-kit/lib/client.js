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
			capBargeIn: "interrupt",
			voiceNav: "Voice conversation",
			voiceTitle: "Voice conversation",
			voiceLead: "Talk with a full-duplex audio model: it listens while it speaks, and you can interrupt it at any time. There is no record or send button.",
			voiceRefresh: "Refresh",
			voiceNoModel: "No live voice model is available yet.",
			voiceNoModelHelp: "Open Audio models, press Refresh and activate MiniCPM-o 4.5 (or add a realtime model in Audio servers).",
			voiceOpenModels: "Open Audio models",
			voiceReady: "Ready",
			voiceNotReady: "Not ready ({state})",
			voiceNotReadyHelp: "The model is not loaded on the server yet. Activate it in Audio models, or wait until loading finishes.",
			voiceModeLegend: "Interruption",
			voiceModeVad: "Interrupt by speaking",
			voiceModeVadHelp: "The server stops the reply as soon as you speak. Use headphones.",
			voiceModeNative: "Model decides",
			voiceModeNativeHelp: "Native full duplex: the model hears you but may finish its sentence first.",
			voiceStart: "Start conversation",
			voiceStarting: "Starting…",
			voiceHeadphones: "Headphones recommended, so the model does not hear itself.",
			voiceError: "Could not start: {message}",
			voiceEnded: "Call ended · {count} interruptions",
			voiceEndedHelp: "The call ran in its own conversation. Saving the call as conversation turns comes in the next iteration.",
			voiceOpenConversation: "Open conversation",
			voiceStateMuted: "Microphone muted",
			voiceStateConnecting: "Connecting…",
			voiceStateAnswering: "Answering",
			voiceStateYou: "You are speaking",
			voiceStateListening: "Listening",
			voiceStateWaiting: "Waiting for you",
			voiceSubMuted: "The model cannot hear you. Unmute to continue.",
			voiceSubInterrupt: "Speak to interrupt.",
			voiceSubNative: "The model decides when to stop.",
			voiceSubDecide: "The model decides every moment: listen or speak.",
			voiceSubListenVad: "Speak any time; the model answers when you pause.",
			voiceSubWaiting: "Reply stopped. The model stays quiet until you have spoken.",
			voiceSubStart: "Say something to begin; the model answers after you speak.",
			voiceTimelineHint: "You and the model on one clock · each cell is 1 second",
			voiceLaneYou: "You",
			voiceLaneModel: "Model",
			voiceNow: "now",
			voiceCaptionEmpty: "The reply appears here as the model speaks.",
			voiceStopped: "— stopped",
			voiceWarnings: "Server warnings: {codes}",
			voiceDetails: "Details",
			voiceDetailFrames: "Microphone frames sent / accepted",
			voiceDetailFirstAudio: "End of your speech → first reply audio",
			voiceDetailInterrupt: "Interruption → server cancelled the reply",
			voiceDetailGaps: "Reply audio gaps (audio arrived late)",
			voiceDetailBuffer: "Playback buffer",
			voiceDetailHeld: "Replies the model started on its own (not played)",
			voiceDetailTurn: "Turn mode reported by the host",
			voiceDetailAudio: "Microphone processing",
			voiceMute: "Mute",
			voiceUnmute: "Unmute",
			voiceStopReply: "Stop reply",
			voiceEnd: "End",
			voiceSessionTitle: "Voice conversation"
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
			capBargeIn: "打断",
			voiceNav: "语音对话",
			voiceTitle: "语音对话",
			voiceLead: "与全双工音频模型对话：它边听边说，你随时可以打断。不需要录音或发送按钮。",
			voiceRefresh: "刷新",
			voiceNoModel: "还没有可用的实时语音模型。",
			voiceNoModelHelp: "打开“音频模型”，按“刷新”并启用 MiniCPM-o 4.5（或在“音频服务器”中添加实时模型）。",
			voiceOpenModels: "打开音频模型",
			voiceReady: "可用",
			voiceNotReady: "未就绪（{state}）",
			voiceNotReadyHelp: "模型尚未在服务器上加载。请在“音频模型”中启用，或等待加载完成。",
			voiceModeLegend: "打断方式",
			voiceModeVad: "说话即可打断",
			voiceModeVadHelp: "一开口服务器就停止回答。建议佩戴耳机。",
			voiceModeNative: "由模型决定",
			voiceModeNativeHelp: "原生全双工：模型听得到你，但可能说完这句才停。",
			voiceStart: "开始对话",
			voiceStarting: "正在开始…",
			voiceHeadphones: "建议佩戴耳机，避免模型听到自己的声音。",
			voiceError: "无法开始：{message}",
			voiceEnded: "通话已结束 · 打断 {count} 次",
			voiceEndedHelp: "通话在独立的会话中进行。把通话保存为会话内容会在下一轮迭代加入。",
			voiceOpenConversation: "打开会话",
			voiceStateMuted: "麦克风已静音",
			voiceStateConnecting: "正在连接…",
			voiceStateAnswering: "正在回答",
			voiceStateYou: "你正在说",
			voiceStateListening: "正在听",
			voiceStateWaiting: "等你开口",
			voiceSubMuted: "模型听不到你，取消静音后继续。",
			voiceSubInterrupt: "直接开口即可打断。",
			voiceSubNative: "由模型决定何时停下。",
			voiceSubDecide: "模型随时决定：听，或说。",
			voiceSubListenVad: "随时开口；你停下时模型会回答。",
			voiceSubWaiting: "回答已停止。你说完之前，模型不会再说话。",
			voiceSubStart: "先开口说话，模型会在你说完后回答。",
			voiceTimelineHint: "你与模型在同一时间轴 · 每格 1 秒",
			voiceLaneYou: "你",
			voiceLaneModel: "模型",
			voiceNow: "现在",
			voiceCaptionEmpty: "模型说话时，回答会显示在这里。",
			voiceStopped: "— 已停止",
			voiceWarnings: "服务器警告：{codes}",
			voiceDetails: "详细信息",
			voiceDetailFrames: "麦克风帧 已发送 / 已接受",
			voiceDetailFirstAudio: "你说完 → 第一段回答音频",
			voiceDetailInterrupt: "打断 → 服务端取消回答",
			voiceDetailGaps: "回答音频断续（音频晚到）",
			voiceDetailBuffer: "播放缓冲",
			voiceDetailHeld: "模型自行开口（未播放）",
			voiceDetailTurn: "主机报告的轮次模式",
			voiceDetailAudio: "麦克风处理",
			voiceMute: "静音",
			voiceUnmute: "取消静音",
			voiceStopReply: "停止回答",
			voiceEnd: "结束",
			voiceSessionTitle: "语音对话"
		};
		/** Replace `{name}` placeholders. */
		function format(text, values = {}) {
			return text.replaceAll(/\{([^{}]+)\}/gu, (placeholder, key) => values[key] ?? placeholder);
		}
		//#endregion
		//#region \0dsh-css:packages/third-party/dsh-audio-release-kit/src/client/kit.module.css.mjs
		const css$1 = "._2wzUyW_chipWrap{align-items:center;gap:8px;min-width:0;display:inline-flex}._2wzUyW_chip{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:28px;color:var(--dsw-alias-label-primary);font:inherit;white-space:nowrap;cursor:pointer;border-radius:999px;align-items:center;gap:6px;padding:0 10px;font-size:12px;display:inline-flex}._2wzUyW_chip:hover{border-color:var(--dsw-alias-label-dimmed)}._2wzUyW_chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}._2wzUyW_chip:disabled{opacity:.6;cursor:progress}._2wzUyW_chipDot{background:var(--dsw-alias-brand-primary);border-radius:50%;width:6px;height:6px}._2wzUyW_chipError{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;max-width:240px;font-size:12px;overflow:hidden}._2wzUyW_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}._2wzUyW_card:hover{border-color:var(--dsw-alias-label-dimmed)}._2wzUyW_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}._2wzUyW_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}._2wzUyW_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}._2wzUyW_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}._2wzUyW_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}._2wzUyW_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}._2wzUyW_count{border:.5px solid var(--dsw-alias-border-l4);text-align:center;min-width:22px;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 7px;font-size:12px}._2wzUyW_chevron{color:var(--dsw-alias-label-tertiary);flex:none;line-height:1;transition:transform .16s}._2wzUyW_chevronOpen{transform:rotate(180deg)}._2wzUyW_body{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:14px;margin:0 16px;padding:12px 0 14px;display:flex}._2wzUyW_muted{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:1.5}._2wzUyW_empty{border:.5px dashed var(--dsw-alias-border-l4);border-radius:12px;padding:12px 14px}._2wzUyW_emptyTitle{color:var(--dsw-alias-label-primary);margin:0 0 4px;font-size:14px;font-weight:600}._2wzUyW_routes{flex-direction:column;gap:10px;margin:0;padding:0;list-style:none;display:flex}._2wzUyW_route{background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:8px;padding:12px 14px;display:flex}._2wzUyW_routeHead{flex-wrap:wrap;align-items:baseline;gap:8px 12px;display:flex}._2wzUyW_routeName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600}._2wzUyW_routeUrl{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-size:12px}._2wzUyW_routeMeta{color:var(--dsw-alias-label-tertiary);font-size:12px}._2wzUyW_modelList{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}._2wzUyW_modelRow{flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:13px;display:flex}._2wzUyW_modelName{color:var(--dsw-alias-label-primary)}._2wzUyW_pill{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));border-radius:999px;padding:1px 8px;font-size:12px}._2wzUyW_caps{flex-wrap:wrap;gap:4px 10px;display:flex}._2wzUyW_cap{color:var(--dsw-alias-label-tertiary);font-size:12px}._2wzUyW_capVerified{color:var(--dsw-alias-label-primary)}._2wzUyW_routeActions{flex-wrap:wrap;align-items:center;gap:8px 10px;display:flex}._2wzUyW_primary,._2wzUyW_secondary,._2wzUyW_ghost{height:32px;font:inherit;white-space:nowrap;cursor:pointer;border-radius:16px;justify-content:center;align-items:center;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex}._2wzUyW_primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:0}._2wzUyW_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}._2wzUyW_secondary{border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:0 0}._2wzUyW_secondary:hover:not(:disabled),._2wzUyW_ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}._2wzUyW_ghost{color:var(--dsw-alias-label-tertiary);background:0 0;border:0}._2wzUyW_primary:disabled,._2wzUyW_secondary:disabled,._2wzUyW_ghost:disabled{opacity:.4;cursor:not-allowed}._2wzUyW_primary:focus-visible,._2wzUyW_secondary:focus-visible,._2wzUyW_ghost:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}._2wzUyW_ok{color:var(--dsw-alias-label-primary);font-size:12px}._2wzUyW_bad{color:var(--dsw-alias-label-error,var(--dsw-alias-label-tertiary));overflow-wrap:anywhere;font-size:12px}._2wzUyW_form{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:12px;display:flex}._2wzUyW_formTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:14px;font-weight:600}._2wzUyW_row{flex-wrap:wrap;align-items:flex-end;gap:12px;display:flex}._2wzUyW_field{flex-direction:column;gap:4px;min-width:0;display:flex}._2wzUyW_row ._2wzUyW_field{flex:220px}._2wzUyW_label{color:var(--dsw-alias-label-primary);font-size:13px}._2wzUyW_hint{color:var(--dsw-alias-label-tertiary);font-size:12px}._2wzUyW_input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-2));height:32px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;min-width:0;padding:0 10px;font-size:13px}._2wzUyW_input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0}._2wzUyW_check{height:32px;color:var(--dsw-alias-label-primary);align-items:center;gap:6px;font-size:13px;display:inline-flex}._2wzUyW_footer{justify-content:space-between;align-items:center;gap:12px;display:flex}";
		const tagId$1 = "dsh-audio-release-kit/kit.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-audio-release-kit";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
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
		//#region src/client/reply-language.ts
		/**
		* Language hint of this distribution: users are expected to speak Chinese. No reply language is imposed (user decision,
		* 2026-09-16: kit 0.3.6's strict "always Traditional Chinese" rule made the replies sound unnatural). The hint is used by:
		* - the voice page: MiniCPM-o 4.5's duplex system prompt (`instructions` at `live/open`, fixed for the call), after the
		*   server's default opening line "Streaming Omni Conversation.";
		* - the Audio servers MiMo preset system prompt (presets.ts);
		* - the "DGX audio (no tools)" preset persona: `presets/dgx-audio/agent.cordis.yml` holds the same text as YAML
		*   (test/presets.test.ts compares them).
		*/
		const USER_LANGUAGE_HINT = "預期使用者會使用中文交談。";
		/** MiniCPM-o 4.5 duplex system prompt: the server default line first, then the language hint. */
		const DUPLEX_INSTRUCTIONS = `Streaming Omni Conversation.\n${USER_LANGUAGE_HINT}`;
		//#endregion
		//#region src/client/presets.ts
		/**
		* Distribution presets for the Audio servers form (the SBPLab DGX Spark serving vLLM-Omni) and the model entry the form
		* writes into the `dsh-dgx-audio` settings section.
		*
		* A preset carries the request values its recipe needs, the same values as the validated DGX demo routes:
		* - MiniCPM-o 4.5: chat_template_kwargs, without which replies start with `<think>`;
		* - MiMo-Audio-7B-Instruct: maxTokens 200 and a short system prompt, without which a reply streams for over a minute.
		*
		* The values apply whenever the model id matches a preset, whatever the address, so a user who only changes the server
		* address keeps them.
		*/
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
					systemPrompt: `You are a helpful voice assistant. Answer the user's spoken question briefly. ${USER_LANGUAGE_HINT}`,
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
		//#region src/client/StartupDialogs.tsx
		/**
		* The distribution starts without two upstream first-run dialogs from `ui-settings-models`:
		* - `welcome-notice`: the "Internal Testing Notice";
		* - `deepseek-official`: the official DeepSeek API key step, shown on a blank conversation whenever no model is usable yet
		*   (on a fresh install: before Audio models has listed the DGX Spark models).
		*
		* Each step is shadowed in the `settings.onboarding` list slot: same id and order, a lower priority (the lowest priority
		* renders), and a component that completes the step as soon as it mounts. The DeepSeek API key stays available in
		* Settings → Models.
		*/
		const SKIPPED_STARTUP_STEPS = [{
			id: "welcome-notice",
			order: -100
		}, {
			id: "deepseek-official",
			order: 0
		}];
		/** Completes the step it stands in for; renders nothing. */
		function SkipStartupStep(props) {
			const { complete } = props;
			(0, react.useEffect)(() => {
				complete();
			}, [complete]);
			return null;
		}
		//#endregion
		//#region src/client/voice/live-session.ts
		/**
		* Voice conversation session for the release-kit voice page: microphone → host live route, host feed → speaker.
		*
		* Talks only to the dsh-dgx-audio host routes (CONTRACT §3 feed, §5 live): `live/open`, `live/append`, `live/control`,
		* `live/close` and `GET events`. Nothing here contacts a model server. The microphone is opened (and its permission
		* granted) before `live/open`, so a refused permission never leaves a backend session open. While muted, silence frames
		* keep flowing: a native-duplex model needs a continuous frame clock, and the host closes idle sessions after 15 s.
		*/
		const PREFIX = "/api/dsh-dgx-audio/v1";
		const FRAME_SAMPLES = 3200;
		const TIMELINE_KEEP_MS = 24e3;
		const SPEAKING_HOLD_MS = 1200;
		const PLAYBACK_BUFFER_START_S = .3;
		const PLAYBACK_BUFFER_STEP_S = .25;
		const PLAYBACK_BUFFER_MAX_S = 1;
		const RESUME_LEVEL = .2;
		const RESUME_MS = 300;
		const TURN_END_MS = 700;
		const TAP_SOURCE = `class VoiceTap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true }
}
registerProcessor('dsh-voice-tap', VoiceTap)`;
		function pcm16(samples) {
			const out = new Uint8Array(samples.length * 2);
			const view = new DataView(out.buffer);
			for (let i = 0; i < samples.length; i++) {
				const s = Math.max(-1, Math.min(1, samples[i]));
				view.setInt16(i * 2, s < 0 ? s * 32768 : s * 32767, true);
			}
			return out;
		}
		function rms(samples) {
			let sum = 0;
			for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
			return Math.sqrt(sum / Math.max(1, samples.length));
		}
		async function postJson(path, body) {
			const response = await fetch(path, {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			const json = await response.json().catch(() => ({
				ok: false,
				error: {
					code: `HTTP_${response.status}`,
					message: response.statusText
				}
			}));
			if (!response.ok || json?.ok === false) {
				const error = new Error(json?.error?.message ?? `HTTP ${response.status}`);
				error.code = json?.error?.code;
				throw error;
			}
			return json;
		}
		var VoiceLiveSession = class {
			snapshot = {
				phase: "idle",
				muted: false,
				turnMode: "server-vad",
				speaking: false,
				userSpeaking: false,
				levels: [],
				decisions: [],
				interruptions: [],
				framesSent: 0,
				framesAccepted: 0,
				responseActive: false,
				playbackGaps: 0,
				playbackGapMs: 0,
				playbackBufferMs: PLAYBACK_BUFFER_START_S * 1e3,
				waitingForUser: false,
				heldReplies: 0,
				warnings: []
			};
			listeners = /* @__PURE__ */ new Set();
			liveId;
			sessionId;
			stream;
			captureContext;
			captureNode;
			playbackContext;
			feedAbort;
			pending = [];
			pendingLength = 0;
			seq = 0;
			sendChain = Promise.resolve();
			streams = /* @__PURE__ */ new Map();
			texts = /* @__PURE__ */ new Map();
			activeResponse;
			lastStreamId;
			replyOpen = false;
			heldIds = /* @__PURE__ */ new Set();
			loudMs = 0;
			quietMs = 0;
			userTurnSeen = false;
			bufferS = PLAYBACK_BUFFER_START_S;
			userLevel = 0;
			modelLevelUntil = 0;
			modelLevel = 0;
			speechEndedAt;
			bargeAt;
			ackTimer;
			tickTimer;
			getSnapshot = () => this.snapshot;
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			set(patch) {
				this.snapshot = {
					...this.snapshot,
					...patch
				};
				for (const listener of this.listeners) listener();
			}
			setTurnMode(mode) {
				if (this.snapshot.phase === "live" || this.snapshot.phase === "starting") return;
				this.set({ turnMode: mode });
			}
			setMuted(muted) {
				this.set({ muted });
			}
			async start(options) {
				if (this.snapshot.phase === "starting" || this.snapshot.phase === "live") return;
				this.reset(options.turnMode);
				this.set({
					phase: "starting",
					error: void 0,
					waitingForUser: true,
					waitReason: "start"
				});
				try {
					this.stream = await navigator.mediaDevices.getUserMedia({
						audio: {
							echoCancellation: true,
							noiseSuppression: true,
							autoGainControl: true,
							channelCount: 1
						},
						video: false
					});
					this.playbackContext = new AudioContext();
					await this.playbackContext.resume();
					this.sessionId = options.sessionId;
					this.openFeed(options.sessionId);
					const opened = await postJson(`${PREFIX}/live/open`, {
						sessionId: options.sessionId,
						provider: options.provider,
						model: options.model,
						...options.turnMode === "server-vad" ? { turnDetection: "server_vad" } : {},
						...options.instructions ? { instructions: options.instructions } : {}
					});
					this.liveId = String(opened.liveId);
					await this.openCapture();
					this.ackTimer = setInterval(() => {
						this.sendAcks();
					}, 500);
					this.tickTimer = setInterval(() => {
						this.tick();
					}, 100);
					this.set({
						phase: "live",
						startedAt: performance.now()
					});
				} catch (error) {
					const code = error.code;
					await this.teardown();
					this.set({
						phase: "error",
						error: code === void 0 ? String(error.message ?? error) : `${code}: ${error.message}`
					});
				}
			}
			/**
			* Stop the reply that is playing now. Local audio stops at once, also when the server has already finished generating
			* and only playback remains. A reply still open on the server is cancelled with `cancel-response` (not `barge-in`,
			* which tells a duplex model the user is taking the turn and, observed on MiniCPM-o 4.5, leads it to start a new reply
			* into the silence). The host then gets a truncating playback ack, so the model keeps only what was heard. Until the
			* user speaks again, replies the model starts are cancelled and not played.
			*/
			stopReply() {
				const liveId = this.liveId;
				const target = this.activeResponse ?? this.lastStreamId;
				if (this.snapshot.phase !== "live" || liveId === void 0 || target === void 0) return;
				const context = this.playbackContext;
				const stream = this.streams.get(target);
				const heardMs = stream === void 0 || context === void 0 ? void 0 : this.heardMs(stream, context);
				for (const id of this.streams.keys()) this.flushPlayback(id);
				this.replyOpen = false;
				this.markStopped(target);
				this.loudMs = 0;
				this.quietMs = 0;
				this.userTurnSeen = false;
				this.set({
					interruptions: [...this.snapshot.interruptions, performance.now()],
					speaking: false,
					waitingForUser: true,
					waitReason: "stopped"
				});
				const cancel = this.activeResponse !== void 0;
				const clickedAt = performance.now();
				this.heldIds.add(target);
				const control = `${PREFIX}/live/control?liveId=${encodeURIComponent(liveId)}`;
				(async () => {
					if (cancel) {
						if ((await postJson(control, {
							type: "cancel-response",
							responseId: target,
							wait: true,
							waitMs: 3e3
						}).catch(() => void 0))?.outcome === "cancelled") this.set({ lastInterruptMs: Math.round(performance.now() - clickedAt) });
					}
					if (heardMs !== void 0) {
						if (stream !== void 0) stream.playedMs = heardMs;
						await postJson(control, {
							type: "playback-ack",
							responseId: target,
							playedMs: heardMs,
							truncate: true
						}).catch(() => {});
					}
				})();
			}
			/** A reply that starts while waiting for the user: cancel it on the server and never play it. */
			holdReply(id) {
				if (this.heldIds.has(id)) return;
				this.heldIds.add(id);
				this.set({ heldReplies: this.snapshot.heldReplies + 1 });
				const liveId = this.liveId;
				if (liveId !== void 0) postJson(`${PREFIX}/live/control?liveId=${encodeURIComponent(liveId)}`, {
					type: "cancel-response",
					responseId: id
				}).catch(() => {});
			}
			/** The user's turn after Stop reply has ended: replies created from now on are played again. */
			userTurnEnded() {
				if (!this.snapshot.waitingForUser) return;
				this.loudMs = 0;
				this.quietMs = 0;
				this.userTurnSeen = false;
				this.set({
					waitingForUser: false,
					waitReason: void 0
				});
			}
			async end() {
				if (this.snapshot.phase !== "live" && this.snapshot.phase !== "starting") return;
				this.set({ phase: "closing" });
				for (const id of this.streams.keys()) this.flushPlayback(id);
				const liveId = this.liveId;
				await this.stopCapture();
				if (liveId !== void 0) await postJson(`${PREFIX}/live/close?liveId=${encodeURIComponent(liveId)}`, {}).catch(() => {});
				await this.teardown();
				this.set({
					phase: "closed",
					speaking: false,
					userSpeaking: false
				});
			}
			dispose() {
				this.end();
				this.listeners.clear();
			}
			reset(turnMode) {
				this.streams.clear();
				this.texts.clear();
				this.activeResponse = void 0;
				this.lastStreamId = void 0;
				this.replyOpen = false;
				this.heldIds.clear();
				this.loudMs = 0;
				this.quietMs = 0;
				this.userTurnSeen = false;
				this.bufferS = PLAYBACK_BUFFER_START_S;
				this.seq = 0;
				this.pending = [];
				this.pendingLength = 0;
				this.speechEndedAt = void 0;
				this.bargeAt = void 0;
				this.snapshot = {
					phase: "idle",
					muted: false,
					turnMode,
					speaking: false,
					userSpeaking: false,
					levels: [],
					decisions: [],
					interruptions: [],
					framesSent: 0,
					framesAccepted: 0,
					responseActive: false,
					playbackGaps: 0,
					playbackGapMs: 0,
					playbackBufferMs: PLAYBACK_BUFFER_START_S * 1e3,
					waitingForUser: false,
					heldReplies: 0,
					warnings: []
				};
			}
			async openCapture() {
				const context = new AudioContext({ sampleRate: 16e3 });
				this.captureContext = context;
				const source = context.createMediaStreamSource(this.stream);
				const onFrame = (samples) => {
					this.onCapture(samples);
				};
				try {
					const url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: "application/javascript" }));
					await context.audioWorklet.addModule(url);
					URL.revokeObjectURL(url);
					const node = new AudioWorkletNode(context, "dsh-voice-tap");
					node.port.onmessage = (event) => {
						onFrame(event.data);
					};
					source.connect(node);
					this.captureNode = node;
				} catch {
					const processor = context.createScriptProcessor(2048, 1, 1);
					processor.onaudioprocess = (event) => {
						onFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
					};
					source.connect(processor);
					processor.connect(context.destination);
					this.captureNode = processor;
				}
				await context.resume();
			}
			onCapture(samples) {
				if (this.snapshot.phase !== "live" && this.snapshot.phase !== "starting") return;
				const level = this.snapshot.muted ? 0 : Math.min(1, rms(samples) * 6);
				this.userLevel = Math.max(this.userLevel * .6, level);
				if (this.snapshot.waitingForUser) {
					const ms = samples.length / 16e3 * 1e3;
					if (level >= RESUME_LEVEL) {
						this.loudMs += ms;
						this.quietMs = 0;
						if (this.loudMs >= RESUME_MS) this.userTurnSeen = true;
					} else {
						this.loudMs = 0;
						if (this.userTurnSeen) {
							this.quietMs += ms;
							if (this.quietMs >= TURN_END_MS) this.userTurnEnded();
						}
					}
				}
				const frame = this.snapshot.muted ? new Float32Array(samples.length) : samples;
				this.pending.push(frame);
				this.pendingLength += frame.length;
				while (this.pendingLength >= FRAME_SAMPLES) {
					const out = new Float32Array(FRAME_SAMPLES);
					let filled = 0;
					while (filled < FRAME_SAMPLES) {
						const head = this.pending[0];
						const take = Math.min(head.length, FRAME_SAMPLES - filled);
						out.set(head.subarray(0, take), filled);
						filled += take;
						if (take === head.length) this.pending.shift();
						else this.pending[0] = head.subarray(take);
					}
					this.pendingLength -= FRAME_SAMPLES;
					this.enqueueFrame(pcm16(out));
				}
			}
			enqueueFrame(bytes) {
				const liveId = this.liveId;
				if (liveId === void 0) return;
				const seq = this.seq++;
				this.sendChain = this.sendChain.then(async () => {
					for (let attempt = 0; attempt < 20; attempt++) {
						if (this.liveId !== liveId) return;
						const response = await fetch(`${PREFIX}/live/append?liveId=${encodeURIComponent(liveId)}&seq=${seq}`, {
							method: "POST",
							credentials: "include",
							headers: { "content-type": "application/octet-stream" },
							body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
						}).catch(() => void 0);
						if (response?.ok) {
							this.set({ framesSent: this.snapshot.framesSent + 1 });
							return;
						}
						const status = response?.status;
						if (status === 429 || status === 503) {
							await new Promise((r) => setTimeout(r, 120));
							continue;
						}
						if (status === 410) return;
						return;
					}
				});
			}
			openFeed(sessionId) {
				const abort = new AbortController();
				this.feedAbort = abort;
				(async () => {
					const response = await fetch(`${PREFIX}/events?sessionId=${encodeURIComponent(sessionId)}`, {
						credentials: "include",
						signal: abort.signal
					}).catch(() => void 0);
					if (!response?.body) return;
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					for (;;) {
						const { value, done } = await reader.read().catch(() => ({
							value: void 0,
							done: true
						}));
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						let newline = buffer.indexOf("\n");
						while (newline >= 0) {
							const line = buffer.slice(0, newline).trim();
							buffer = buffer.slice(newline + 1);
							if (line !== "") try {
								this.onEvent(JSON.parse(line));
							} catch {}
							newline = buffer.indexOf("\n");
						}
					}
				})();
			}
			onEvent(event) {
				if (event.liveId !== void 0 && event.liveId !== this.liveId) return;
				switch (event.type) {
					case "live.state":
						if (event.state === "ready" && event.turn !== void 0) this.set({ turnReported: typeof event.turn === "string" ? event.turn : event.turn?.mode ?? void 0 });
						if (event.state === "ready" && Array.isArray(event.warnings) && event.warnings.length > 0) this.set({ warnings: event.warnings.map((w) => String(w.code ?? w)) });
						if (event.state === "closed" && this.snapshot.phase === "live") {
							this.teardown();
							this.set({
								phase: event.error ? "error" : "closed",
								error: event.error ? `${event.error.code ?? ""} ${event.error.message ?? ""}`.trim() : void 0
							});
						}
						break;
					case "live.decision":
						if (event.decision === "listen" || event.decision === "speak" || event.decision === "overlap") this.set({ decisions: this.trim([...this.snapshot.decisions, {
							at: performance.now(),
							decision: event.decision
						}]) });
						break;
					case "live.speech":
						if (event.event === "started") {
							if (this.snapshot.waitingForUser) this.userTurnSeen = true;
							this.set({ userSpeaking: true });
							if (this.activeResponse !== void 0 && this.snapshot.turnMode === "server-vad") this.bargeAt = performance.now();
						}
						if (event.event === "stopped" || event.event === "committed") {
							this.set({ userSpeaking: false });
							this.speechEndedAt = performance.now();
							if (this.userTurnSeen) this.userTurnEnded();
						}
						break;
					case "live.input.accepted":
						this.set({ framesAccepted: this.snapshot.framesAccepted + 1 });
						break;
					case "live.response": {
						const id = String(event.responseId);
						if (event.status === "created" && this.snapshot.waitingForUser) {
							this.holdReply(id);
							break;
						}
						if (event.status !== "created" && this.activeResponse === id) {
							this.activeResponse = void 0;
							this.replyOpen = false;
							this.set({ responseActive: false });
						}
						if (this.heldIds.has(id)) break;
						if (event.status === "created") {
							this.activeResponse = id;
							this.replyOpen = true;
							this.texts.set(id, "");
							this.set({ responseActive: true });
						}
						if (event.status === "cancelled") {
							this.flushPlayback(id);
							this.markStopped(id);
							if (this.bargeAt !== void 0) {
								this.set({
									interruptions: [...this.snapshot.interruptions, performance.now()],
									lastInterruptMs: Math.round(performance.now() - this.bargeAt)
								});
								this.bargeAt = void 0;
							}
						}
						break;
					}
					case "audio.format": {
						const stream = this.streamFor(event.streamId);
						if (Number.isFinite(event.sampleRate)) stream.sampleRate = event.sampleRate;
						break;
					}
					case "audio.chunk":
						if (this.heldIds.has(String(event.streamId))) break;
						if (this.snapshot.waitingForUser && !this.streams.has(String(event.streamId))) {
							this.holdReply(String(event.streamId));
							break;
						}
						this.schedule(event);
						break;
					case "audio.epoch": {
						const stream = this.streams.get(event.streamId);
						if (stream !== void 0) {
							stream.epoch = event.epoch;
							this.flushPlayback(event.streamId);
						}
						break;
					}
					case "audio.end": {
						const stream = this.streams.get(event.streamId);
						if (stream !== void 0) stream.ended = true;
						if (this.activeResponse === void 0 || this.activeResponse === event.streamId) this.replyOpen = false;
						if (event.status === "cancelled") {
							this.flushPlayback(event.streamId);
							this.markStopped(event.streamId);
						}
						break;
					}
					case "text.delta": {
						const id = String(event.responseId ?? event.streamId);
						if (this.heldIds.has(id) || this.snapshot.caption?.responseId === id && this.snapshot.caption.stopped) break;
						const text = (this.texts.get(id) ?? "") + String(event.text ?? "");
						this.texts.set(id, text);
						const caption = this.snapshot.caption;
						if (caption !== void 0 && caption.responseId !== id) this.set({ previousCaption: caption });
						this.set({ caption: {
							responseId: id,
							text,
							stopped: false
						} });
						break;
					}
					default: break;
				}
			}
			streamFor(id) {
				let stream = this.streams.get(id);
				if (stream === void 0) {
					stream = {
						id,
						sampleRate: 24e3,
						epoch: 0,
						cursor: 0,
						playedBaseMs: 0,
						playedMs: 0,
						sources: /* @__PURE__ */ new Set(),
						ended: false
					};
					this.streams.set(id, stream);
				}
				return stream;
			}
			schedule(event) {
				const context = this.playbackContext;
				if (context === void 0 || typeof event.data !== "string") return;
				const stream = this.streamFor(String(event.streamId));
				if (Number.isFinite(event.epoch) && event.epoch < stream.epoch) return;
				const binary = atob(event.data);
				const count = Math.floor(binary.length / 2);
				if (count === 0) return;
				const buffer = context.createBuffer(1, count, stream.sampleRate);
				const channel = buffer.getChannelData(0);
				let energy = 0;
				for (let i = 0; i < count; i++) {
					channel[i] = ((binary.charCodeAt(i * 2) | binary.charCodeAt(i * 2 + 1) << 8) << 16 >> 16) / 32768;
					energy += channel[i] * channel[i];
				}
				const source = context.createBufferSource();
				source.buffer = buffer;
				source.connect(context.destination);
				const when = stream.cursor > context.currentTime + .01 ? stream.cursor : context.currentTime + this.bufferS;
				if (stream.startedAt !== void 0 && stream.cursor > 0 && when > stream.cursor + .02) {
					this.bufferS = Math.min(PLAYBACK_BUFFER_MAX_S, this.bufferS + PLAYBACK_BUFFER_STEP_S);
					this.set({
						playbackGaps: this.snapshot.playbackGaps + 1,
						playbackGapMs: this.snapshot.playbackGapMs + Math.round((when - stream.cursor) * 1e3),
						playbackBufferMs: Math.round(this.bufferS * 1e3)
					});
				}
				if (stream.startedAt === void 0) {
					stream.startedAt = when;
					if (this.speechEndedAt !== void 0 && stream.playedBaseMs === 0) {
						this.set({ firstAudioMs: Math.round(performance.now() - this.speechEndedAt + (when - context.currentTime) * 1e3) });
						this.speechEndedAt = void 0;
					}
				}
				source.start(when);
				stream.cursor = when + buffer.duration;
				stream.sources.add(source);
				source.onended = () => {
					stream.sources.delete(source);
				};
				const level = Math.min(1, Math.sqrt(energy / count) * 5);
				const untilMs = performance.now() + (stream.cursor - context.currentTime) * 1e3;
				this.modelLevelUntil = Math.max(this.modelLevelUntil, untilMs);
				this.modelLevel = Math.max(this.modelLevel * .5, level);
				this.activeResponse = this.activeResponse ?? stream.id;
				this.lastStreamId = stream.id;
				if (!stream.ended) this.replyOpen = true;
			}
			flushPlayback(id) {
				const stream = this.streams.get(id);
				if (stream === void 0) return;
				const context = this.playbackContext;
				if (context !== void 0) stream.playedBaseMs = this.heardMs(stream, context);
				for (const source of stream.sources) try {
					source.stop();
				} catch {}
				stream.sources.clear();
				stream.cursor = 0;
				stream.startedAt = void 0;
				this.modelLevelUntil = 0;
			}
			/** Reply audio of `stream` actually played so far (before and since the last flush). */
			heardMs(stream, context) {
				const since = stream.startedAt === void 0 ? 0 : Math.max(0, (Math.min(context.currentTime, stream.cursor) - stream.startedAt) * 1e3);
				return Math.round(stream.playedBaseMs + since);
			}
			markStopped(id) {
				const caption = this.snapshot.caption;
				if (caption?.responseId === id && !caption.stopped) this.set({ caption: {
					...caption,
					stopped: true
				} });
			}
			sendAcks() {
				const context = this.playbackContext;
				const liveId = this.liveId;
				if (context === void 0 || liveId === void 0) return;
				for (const stream of this.streams.values()) {
					const playedMs = this.heardMs(stream, context);
					if (playedMs <= stream.playedMs) continue;
					stream.playedMs = playedMs;
					postJson(`${PREFIX}/live/control?liveId=${encodeURIComponent(liveId)}`, {
						type: "playback-ack",
						responseId: stream.id,
						playedMs
					}).catch(() => {});
				}
			}
			tick() {
				const now = performance.now();
				const audible = now < this.modelLevelUntil;
				const speaking = audible || this.replyOpen && this.modelLevelUntil > 0 && now < this.modelLevelUntil + SPEAKING_HOLD_MS;
				const sample = {
					at: now,
					user: this.snapshot.muted ? 0 : this.userLevel,
					model: audible ? Math.max(.12, this.modelLevel) : 0
				};
				this.userLevel *= .7;
				this.set({
					levels: this.trim([...this.snapshot.levels, sample]),
					speaking
				});
			}
			trim(items) {
				const cutoff = performance.now() - TIMELINE_KEEP_MS;
				let start = 0;
				while (start < items.length && items[start].at < cutoff) start++;
				return start === 0 ? items : items.slice(start);
			}
			async stopCapture() {
				try {
					this.captureNode?.disconnect();
				} catch {}
				for (const track of this.stream?.getTracks() ?? []) track.stop();
				await this.captureContext?.close().catch(() => {});
				this.captureNode = void 0;
				this.captureContext = void 0;
				this.stream = void 0;
			}
			async teardown() {
				if (this.ackTimer !== void 0) clearInterval(this.ackTimer);
				if (this.tickTimer !== void 0) clearInterval(this.tickTimer);
				this.ackTimer = void 0;
				this.tickTimer = void 0;
				this.feedAbort?.abort();
				this.feedAbort = void 0;
				await this.stopCapture();
				await this.playbackContext?.close().catch(() => {});
				this.playbackContext = void 0;
				this.liveId = void 0;
			}
		};
		//#endregion
		//#region \0dsh-css:packages/third-party/dsh-audio-release-kit/src/client/voice/voice.module.css.mjs
		const css = "._5Y-jkq_page{width:100%;max-width:880px;color:var(--dsw-alias-label-primary);align-content:start;gap:16px;margin:0 auto;padding:28px 36px;display:grid}._5Y-jkq_head{flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:12px;display:flex}._5Y-jkq_title{margin:0;font-size:24px;font-weight:600;line-height:32px}._5Y-jkq_lead{color:var(--dsw-alias-label-secondary);max-width:62ch;margin:4px 0 0}._5Y-jkq_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;gap:10px;padding:16px 18px;display:grid}._5Y-jkq_stack{gap:10px;display:grid}._5Y-jkq_row{flex-wrap:wrap;align-items:center;gap:10px;display:flex}._5Y-jkq_strong{font-weight:500}._5Y-jkq_muted{color:var(--dsw-alias-label-tertiary);font-size:13px}._5Y-jkq_help{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;display:block}._5Y-jkq_warn{color:var(--dsw-alias-state-warn-primary);margin:0;font-size:13px}._5Y-jkq_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px}._5Y-jkq_badge,._5Y-jkq_badgeMono{border:.5px solid var(--dsw-alias-border-l4);height:22px;color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:6px;align-items:center;padding:0 8px;font-size:12px;display:inline-flex}._5Y-jkq_badgeMono{font-variant-numeric:tabular-nums;font-family:var(--ds-font-family-code,ui-monospace, monospace)}._5Y-jkq_dotOk,._5Y-jkq_dotWarn{background:var(--dsw-alias-state-success-primary);border-radius:50%;width:8px;height:8px}._5Y-jkq_dotWarn{background:var(--dsw-alias-state-warn-primary)}._5Y-jkq_modes{border:0;gap:6px;margin:0;padding:0;display:grid}._5Y-jkq_mode{cursor:pointer;border-radius:10px;grid-template-columns:auto 1fr;align-items:start;gap:8px;padding:6px 8px;display:grid}._5Y-jkq_mode:hover{background:var(--dsw-alias-interactive-bg-hover)}._5Y-jkq_primary,._5Y-jkq_secondary,._5Y-jkq_danger,._5Y-jkq_toggleOn{appearance:none;font:inherit;cursor:pointer;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;color:var(--dsw-alias-label-primary);border-radius:10px;padding:0 14px;font-weight:500}._5Y-jkq_secondary:hover{background:var(--dsw-alias-interactive-bg-hover)}._5Y-jkq_primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);height:40px;color:var(--dsw-alias-label-primary-inverted);padding:0 18px}._5Y-jkq_toggleOn{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}._5Y-jkq_danger{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:#fff}._5Y-jkq_primary:disabled,._5Y-jkq_secondary:disabled{opacity:.45;cursor:not-allowed}._5Y-jkq_primary:focus-visible,._5Y-jkq_secondary:focus-visible,._5Y-jkq_danger:focus-visible,._5Y-jkq_toggleOn:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px}._5Y-jkq_call{min-height:100%;color:var(--dsw-alias-label-primary);flex-direction:column;display:flex}._5Y-jkq_callHead{border-bottom:.5px solid var(--dsw-alias-border-l4);flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;padding:14px 28px;display:flex}._5Y-jkq_callTitle{margin:0;font-size:17px;font-weight:600;line-height:24px}._5Y-jkq_callBody{flex:1;align-content:start;gap:14px;width:100%;max-width:960px;margin:0 auto;padding:20px 28px;display:grid}._5Y-jkq_state{align-items:center;gap:12px;font-size:22px;font-weight:600;line-height:30px;display:flex}._5Y-jkq_pulse,._5Y-jkq_pulseSpeak,._5Y-jkq_pulseOff{background:var(--dsw-alias-state-success-primary);border-radius:50%;flex:none;width:12px;height:12px}._5Y-jkq_pulseSpeak{background:var(--dsw-alias-link)}._5Y-jkq_pulseOff{background:var(--dsw-alias-label-tertiary)}@media (prefers-reduced-motion:no-preference){._5Y-jkq_pulse,._5Y-jkq_pulseSpeak{animation:1.6s ease-in-out infinite _5Y-jkq_voicePulse}}@keyframes _5Y-jkq_voicePulse{50%{opacity:.45}}._5Y-jkq_lanes{border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;padding:10px 12px 6px}._5Y-jkq_lanesHead{color:var(--dsw-alias-label-tertiary);margin-bottom:6px;font-size:12px}._5Y-jkq_canvas{width:100%;height:140px;display:block}._5Y-jkq_captions{background:var(--dsw-alias-bg-layer-2);border-radius:12px;gap:6px;min-height:96px;padding:12px 16px;display:grid}._5Y-jkq_capPrev{color:var(--dsw-alias-label-tertiary);font-size:13px}._5Y-jkq_capNow{max-width:64ch;font-size:17px;line-height:27px}._5Y-jkq_stopped{color:var(--dsw-alias-state-error-primary);margin-left:8px;font-size:13px}._5Y-jkq_details{border-collapse:collapse;width:100%;max-width:520px;font-size:12px}._5Y-jkq_details td{border-top:.5px solid var(--dsw-alias-border-l2);padding:5px 8px}._5Y-jkq_details td:last-child{text-align:right;font-variant-numeric:tabular-nums}._5Y-jkq_controls{border-top:.5px solid var(--dsw-alias-border-l4);flex-wrap:wrap;justify-content:center;align-items:center;gap:10px;padding:12px 18px 18px;display:flex}";
		const tagId = "dsh-audio-release-kit/voice.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-audio-release-kit";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var voice_module_css_default = {
			"badge": "_5Y-jkq_badge",
			"badgeMono": "_5Y-jkq_badgeMono",
			"call": "_5Y-jkq_call",
			"callBody": "_5Y-jkq_callBody",
			"callHead": "_5Y-jkq_callHead",
			"callTitle": "_5Y-jkq_callTitle",
			"canvas": "_5Y-jkq_canvas",
			"capNow": "_5Y-jkq_capNow",
			"capPrev": "_5Y-jkq_capPrev",
			"captions": "_5Y-jkq_captions",
			"card": "_5Y-jkq_card",
			"controls": "_5Y-jkq_controls",
			"danger": "_5Y-jkq_danger",
			"details": "_5Y-jkq_details",
			"dotOk": "_5Y-jkq_dotOk",
			"dotWarn": "_5Y-jkq_dotWarn",
			"error": "_5Y-jkq_error",
			"head": "_5Y-jkq_head",
			"help": "_5Y-jkq_help",
			"lanes": "_5Y-jkq_lanes",
			"lanesHead": "_5Y-jkq_lanesHead",
			"lead": "_5Y-jkq_lead",
			"mode": "_5Y-jkq_mode",
			"modes": "_5Y-jkq_modes",
			"muted": "_5Y-jkq_muted",
			"page": "_5Y-jkq_page",
			"primary": "_5Y-jkq_primary",
			"pulse": "_5Y-jkq_pulse",
			"pulseOff": "_5Y-jkq_pulseOff",
			"pulseSpeak": "_5Y-jkq_pulseSpeak",
			"row": "_5Y-jkq_row",
			"secondary": "_5Y-jkq_secondary",
			"stack": "_5Y-jkq_stack",
			"state": "_5Y-jkq_state",
			"stopped": "_5Y-jkq_stopped",
			"strong": "_5Y-jkq_strong",
			"title": "_5Y-jkq_title",
			"toggleOn": "_5Y-jkq_toggleOn",
			"voicePulse": "_5Y-jkq_voicePulse",
			"warn": "_5Y-jkq_warn"
		};
		//#endregion
		//#region src/client/voice/VoicePage.tsx
		/**
		* Main view "Voice conversation": one-tap full-duplex call with a realtime audio model served by dsh-dgx-audio.
		* Iteration 1 (audio only): readiness, start, listening/speaking state, reply captions, a two-lane timeline on one
		* clock (you / model, 1-second decision cells), mute, stop reply, interruption mode, end, details.
		*/
		const WINDOW_MS = 16e3;
		function candidatesOf(routes) {
			const out = [];
			for (const route of routes.routes) for (const model of route.models) {
				if (model.mode !== "realtime") continue;
				const activation = model.activation?.state;
				out.push({
					provider: route.provider,
					model: model.id,
					label: model.name ?? model.id,
					activation
				});
			}
			return out.sort((a, b) => Number(b.activation === "ready" || b.activation === void 0) - Number(a.activation === "ready" || a.activation === void 0) || Number(/minicpm/i.test(b.label)) - Number(/minicpm/i.test(a.label)));
		}
		function clock(ms) {
			const s = Math.max(0, Math.floor(ms / 1e3));
			return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
		}
		function drawTimeline(canvas, snap, t) {
			const width = canvas.clientWidth;
			const height = 140;
			const dpr = window.devicePixelRatio || 1;
			if (canvas.width !== Math.round(width * dpr)) {
				canvas.width = Math.round(width * dpr);
				canvas.height = Math.round(height * dpr);
			}
			const ctx = canvas.getContext("2d");
			if (ctx === null) return;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			const style = getComputedStyle(canvas);
			const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
			const label = token("--dsw-alias-label-primary", "#0f1115");
			const muted = token("--dsw-alias-label-tertiary", "#81858c");
			const border = token("--dsw-alias-border-l2", "rgba(0,0,0,.1)");
			const link = token("--dsw-alias-link", "rgb(65,118,230)");
			const ok = token("--dsw-alias-state-success-primary", "rgb(34,197,94)");
			const err = token("--dsw-alias-state-error-primary", "rgb(236,19,19)");
			const layer = token("--dsw-alias-bg-layer-2", "rgba(0,0,0,.03)");
			ctx.clearRect(0, 0, width, height);
			const now = performance.now();
			const labelW = 52;
			const plotW = Math.max(10, width - labelW);
			const x = (at) => labelW + plotW - (now - at) / WINDOW_MS * plotW;
			const lanes = [{
				name: t("voiceLaneYou"),
				y: 6
			}, {
				name: t("voiceLaneModel"),
				y: 58
			}];
			const laneH = 44;
			const firstSec = Math.floor((now - WINDOW_MS) / 1e3);
			for (let sec = firstSec; sec * 1e3 <= now; sec++) {
				const x0 = Math.max(labelW, x(sec * 1e3));
				const x1 = Math.min(width, x((sec + 1) * 1e3));
				if (x1 - x0 < 2) continue;
				const inSec = (at) => at >= sec * 1e3 && at < (sec + 1) * 1e3;
				const decision = [...snap.decisions].reverse().find((d) => inSec(d.at))?.decision;
				const spoke = decision === "speak" || decision === void 0 && snap.levels.some((l) => inSec(l.at) && l.model > 0);
				ctx.fillStyle = layer;
				ctx.fillRect(x0 + 1, lanes[0].y, x1 - x0 - 2, laneH);
				ctx.globalAlpha = decision === void 0 && !spoke ? .35 : .18;
				ctx.fillStyle = spoke ? link : ok;
				ctx.fillRect(x0 + 1, lanes[1].y, x1 - x0 - 2, laneH);
				ctx.globalAlpha = 1;
			}
			const barW = Math.max(1.5, plotW / (WINDOW_MS / 100) - 1);
			for (const sample of snap.levels) {
				const bx = x(sample.at);
				if (bx < labelW) continue;
				if (sample.user > .01) {
					const bh = Math.max(2, sample.user * (laneH - 8));
					ctx.globalAlpha = .75;
					ctx.fillStyle = label;
					ctx.fillRect(bx, lanes[0].y + (laneH - bh) / 2, barW, bh);
					ctx.globalAlpha = 1;
				}
				if (sample.model > 0) {
					const bh = Math.max(3, sample.model * (laneH - 12));
					ctx.fillStyle = link;
					ctx.fillRect(bx, lanes[1].y + (laneH - bh) / 2, barW, bh);
				}
			}
			for (const at of snap.interruptions) {
				const bx = x(at);
				if (bx < labelW) continue;
				ctx.fillStyle = err;
				ctx.fillRect(bx, lanes[0].y, 2, lanes[1].y + laneH - lanes[0].y);
			}
			ctx.fillStyle = muted;
			ctx.font = `500 12px ${style.fontFamily}`;
			for (const lane of lanes) ctx.fillText(lane.name, 0, lane.y + laneH / 2 + 4);
			ctx.strokeStyle = border;
			ctx.beginPath();
			ctx.moveTo(labelW, height - 16.5);
			ctx.lineTo(width, height - 16.5);
			ctx.stroke();
			ctx.font = `400 10px ${style.fontFamily}`;
			for (let ago = 0; ago <= 15; ago += 5) {
				const tx = width - ago * 1e3 / WINDOW_MS * plotW;
				ctx.fillRect(tx - 1, height - 16, 1, 4);
				ctx.fillText(ago === 0 ? t("voiceNow") : `−${ago} s`, Math.max(labelW, Math.min(tx - (ago === 0 ? 22 : 12), width - 26)), height - 3);
			}
		}
		function VoicePage(props) {
			const t = (key, values) => format(props.t(key), values);
			const face = props.voicePage;
			const snap = (0, react.useSyncExternalStore)(face.session.subscribe, face.session.getSnapshot);
			const routes = (0, react.useSyncExternalStore)(face.routes.subscribe, face.routes.getSnapshot);
			const [sessionId, setSessionId] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const [details, setDetails] = (0, react.useState)(false);
			const [startError, setStartError] = (0, react.useState)();
			const canvas = (0, react.useRef)(null);
			const candidate = candidatesOf(routes)[0];
			const ready = candidate !== void 0 && (candidate.activation === void 0 || candidate.activation === "ready");
			const inCall = snap.phase === "starting" || snap.phase === "live" || snap.phase === "closing";
			(0, react.useEffect)(() => {
				face.routes.refresh();
			}, []);
			(0, react.useEffect)(() => {
				if (canvas.current !== null && inCall) drawTimeline(canvas.current, snap, t);
			});
			const start = async () => {
				if (candidate === void 0) return;
				setBusy(true);
				setStartError(void 0);
				try {
					const id = await face.createSession(candidate);
					setSessionId(id);
					await face.session.start({
						sessionId: id,
						provider: candidate.provider,
						model: candidate.model,
						turnMode: snap.turnMode,
						instructions: DUPLEX_INSTRUCTIONS
					});
				} catch (error) {
					setStartError(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			};
			const stateLabel = snap.muted ? t("voiceStateMuted") : snap.phase === "starting" ? t("voiceStateConnecting") : snap.speaking ? t("voiceStateAnswering") : snap.userSpeaking ? t("voiceStateYou") : snap.waitingForUser && snap.waitReason === "stopped" ? t("voiceStateWaiting") : t("voiceStateListening");
			const stateSub = snap.muted ? t("voiceSubMuted") : snap.speaking ? snap.turnMode === "server-vad" ? t("voiceSubInterrupt") : t("voiceSubNative") : snap.waitingForUser ? snap.waitReason === "stopped" ? t("voiceSubWaiting") : t("voiceSubStart") : snap.turnMode === "server-vad" ? t("voiceSubListenVad") : t("voiceSubDecide");
			const pulseClass = snap.muted ? voice_module_css_default.pulseOff : snap.speaking ? voice_module_css_default.pulseSpeak : voice_module_css_default.pulse;
			if (!inCall) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: voice_module_css_default.page,
				"data-testid": "dsh-voice-page",
				"data-phase": snap.phase,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: voice_module_css_default.head,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
							className: voice_module_css_default.title,
							children: t("voiceTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: voice_module_css_default.lead,
							children: t("voiceLead")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: voice_module_css_default.secondary,
							onClick: () => {
								face.routes.refresh();
							},
							children: t("voiceRefresh")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: voice_module_css_default.card,
						children: [candidate === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: voice_module_css_default.stack,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: voice_module_css_default.strong,
									children: t("voiceNoModel")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: voice_module_css_default.muted,
									children: t("voiceNoModelHelp")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: voice_module_css_default.secondary,
									onClick: () => {
										face.openAudioModels();
									},
									children: t("voiceOpenModels")
								}) })
							]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: voice_module_css_default.stack,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: voice_module_css_default.row,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: ready ? voice_module_css_default.dotOk : voice_module_css_default.dotWarn }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: voice_module_css_default.strong,
											children: candidate.label
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: voice_module_css_default.badge,
											children: ready ? t("voiceReady") : t("voiceNotReady", { state: candidate.activation ?? "" })
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
									className: voice_module_css_default.modes,
									disabled: busy,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", {
										className: voice_module_css_default.muted,
										children: t("voiceModeLegend")
									}), ["server-vad", "native-duplex"].map((mode) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: voice_module_css_default.mode,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "dsh-voice-turn",
											value: mode,
											checked: snap.turnMode === mode,
											onChange: () => {
												face.session.setTurnMode(mode);
											},
											"data-testid": `dsh-voice-mode-${mode}`
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: voice_module_css_default.strong,
											children: mode === "server-vad" ? t("voiceModeVad") : t("voiceModeNative")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: voice_module_css_default.help,
											children: mode === "server-vad" ? t("voiceModeVadHelp") : t("voiceModeNativeHelp")
										})] })]
									}, mode))]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: voice_module_css_default.row,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: voice_module_css_default.primary,
										disabled: !ready || busy,
										onClick: () => {
											start();
										},
										"data-testid": "dsh-voice-start",
										children: busy ? t("voiceStarting") : t("voiceStart")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: voice_module_css_default.muted,
										children: t("voiceHeadphones")
									})]
								}),
								!ready ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: voice_module_css_default.warn,
									children: t("voiceNotReadyHelp")
								}) : null
							]
						}), (startError ?? snap.error) !== void 0 && snap.phase !== "closed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: voice_module_css_default.error,
							role: "alert",
							"data-testid": "dsh-voice-error",
							children: t("voiceError", { message: startError ?? snap.error ?? "" })
						}) : null]
					}),
					snap.phase === "closed" && sessionId !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
						className: voice_module_css_default.card,
						"data-testid": "dsh-voice-ended",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: voice_module_css_default.stack,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: voice_module_css_default.strong,
									children: t("voiceEnded", { count: String(snap.interruptions.length) })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: voice_module_css_default.muted,
									children: t("voiceEndedHelp")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: voice_module_css_default.row,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: voice_module_css_default.secondary,
										onClick: () => {
											face.openSession(sessionId);
										},
										children: t("voiceOpenConversation")
									})
								})
							]
						})
					}) : null
				]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: voice_module_css_default.call,
				"data-testid": "dsh-voice-call",
				"data-phase": snap.phase,
				"data-speaking": snap.speaking,
				"data-muted": snap.muted,
				"data-response-active": snap.responseActive,
				"data-playback-gaps": snap.playbackGaps,
				"data-waiting-for-user": snap.waitingForUser,
				"data-wait-reason": snap.waitReason ?? "",
				"data-held-replies": snap.heldReplies,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: voice_module_css_default.callHead,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: voice_module_css_default.row,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
									className: voice_module_css_default.callTitle,
									children: t("voiceTitle")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: voice_module_css_default.badge,
									children: candidate?.label
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: voice_module_css_default.badgeMono,
									"data-testid": "dsh-voice-timer",
									children: clock(snap.startedAt === void 0 ? 0 : performance.now() - snap.startedAt)
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: voice_module_css_default.secondary,
							"aria-expanded": details,
							onClick: () => {
								setDetails(!details);
							},
							children: t("voiceDetails")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: voice_module_css_default.callBody,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: voice_module_css_default.state,
								"aria-live": "polite",
								"data-testid": "dsh-voice-state",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: pulseClass }), stateLabel]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: voice_module_css_default.muted,
								children: stateSub
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: voice_module_css_default.lanes,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: voice_module_css_default.lanesHead,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("voiceTimelineHint") })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("canvas", {
									ref: canvas,
									className: voice_module_css_default.canvas,
									height: 140,
									"aria-label": t("voiceTimelineHint")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: voice_module_css_default.captions,
								"aria-live": "polite",
								"data-testid": "dsh-voice-captions",
								children: [snap.previousCaption !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: voice_module_css_default.capPrev,
									children: snap.previousCaption.text
								}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: voice_module_css_default.capNow,
									children: [snap.caption === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: voice_module_css_default.muted,
										children: t("voiceCaptionEmpty")
									}) : snap.caption.text, snap.caption?.stopped ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: voice_module_css_default.stopped,
										children: t("voiceStopped")
									}) : null]
								})]
							}),
							snap.warnings.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: voice_module_css_default.warn,
								children: t("voiceWarnings", { codes: snap.warnings.join(", ") })
							}) : null,
							details ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
								className: voice_module_css_default.details,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tbody", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("voiceDetailFrames") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [
										snap.framesSent,
										" / ",
										snap.framesAccepted
									] })] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("voiceDetailFirstAudio") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: snap.firstAudioMs === void 0 ? "—" : `${(snap.firstAudioMs / 1e3).toFixed(1)} s` })] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("voiceDetailInterrupt") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: snap.lastInterruptMs === void 0 ? "—" : `${(snap.lastInterruptMs / 1e3).toFixed(2)} s` })] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("voiceDetailGaps") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: snap.playbackGaps === 0 ? "0" : `${snap.playbackGaps} · ${(snap.playbackGapMs / 1e3).toFixed(1)} s` })] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("voiceDetailBuffer") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: `${(snap.playbackBufferMs / 1e3).toFixed(2)} s` })] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("voiceDetailHeld") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: snap.heldReplies })] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("voiceDetailTurn") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: snap.turnReported ?? snap.turnMode })] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("voiceDetailAudio") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: "AEC · NS · AGC" })] })
								] })
							}) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
						className: voice_module_css_default.controls,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: snap.muted ? voice_module_css_default.toggleOn : voice_module_css_default.secondary,
								"aria-pressed": snap.muted,
								onClick: () => {
									face.session.setMuted(!snap.muted);
								},
								"data-testid": "dsh-voice-mute",
								children: snap.muted ? t("voiceUnmute") : t("voiceMute")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: voice_module_css_default.secondary,
								disabled: !snap.speaking,
								onClick: () => {
									face.session.stopReply();
								},
								"data-testid": "dsh-voice-stop",
								children: t("voiceStopReply")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: voice_module_css_default.badge,
								children: snap.turnMode === "server-vad" ? t("voiceModeVad") : t("voiceModeNative")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: voice_module_css_default.danger,
								onClick: () => {
									face.session.end();
								},
								"data-testid": "dsh-voice-end",
								children: t("voiceEnd")
							})
						]
					})
				]
			});
		}
		function VoiceIcon(props) {
			const size = props.size ?? 16;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				"data-testid": "dsh-voice-sidebar-icon",
				"data-active": props.active === true,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "5.5",
					y: "1.5",
					width: "5",
					height: "8.5",
					rx: "2.5",
					stroke: "currentColor",
					strokeWidth: "1.3"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M3 7.5a5 5 0 0 0 10 0M8 12.5v2",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round"
				})]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser half of dsh-audio-release-kit (shared by Web and Desktop):
		* - `settings.plugin.item` card keyed `dsh-dgx-audio`: first-run audio server setup + explicit connection test;
		* - `conversation.input.left` chip: when an audio-adapter model is selected outside the no-tools audio preset,
		*   switch a blank session in place or start a new audio conversation in the same workspace with the same model;
		* - Voice conversation page (`sidebar.panellist` + `main`);
		* - `settings.onboarding`: the upstream Internal Testing Notice and DeepSeek API key steps are skipped (StartupDialogs.tsx).
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
			"remote.session",
			"layout"
		];
		const VOICE_PANEL_ID = "dsh-voice-conversation";
		function unwrap(result, what) {
			if (!result.ok) throw new Error(`${what}: ${result.error?.message ?? result.error?.code ?? "failed"}`);
			return result.value;
		}
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				en,
				zh
			}), "audio-release-kit: dictionaries");
			for (const step of SKIPPED_STARTUP_STEPS) ctx.slots.inject("settings.onboarding", () => ctx.slots.register({
				name: "settings.onboarding",
				id: step.id,
				order: step.order,
				priority: -1
			}, SkipStartupStep));
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
			const voiceSession = new VoiceLiveSession();
			ctx.effect(() => () => {
				voiceSession.dispose();
			}, "audio-release-kit: voice session");
			const voiceFace = {
				session: voiceSession,
				routes,
				async createSession(candidate) {
					const workspace = (ctx.workspaces.list.getSnapshot().items ?? [])[0];
					let created;
					if (workspace !== void 0) created = await ctx.sessions.create({ workspaceId: workspace.workspaceId });
					else {
						created = unwrap(await ctx.remote.session.create({ agentPreset: AUDIO_PRESET_ID }), "create session").sessionId;
						await ctx.sessions.refresh();
					}
					unwrap(await ctx.remote.agentPresets.select(created, AUDIO_PRESET_ID), "select preset");
					const chat = routes.getSnapshot().routes.find((r) => r.provider === candidate.provider)?.models.find((m) => m.mode === "chat");
					if (chat !== void 0) await ctx.remote.session.selectModel({
						sessionId: created,
						provider: candidate.provider,
						model: chat.id
					}).catch(() => void 0);
					return created;
				},
				openSession(sessionId) {
					ctx.uiWorkspace.openSession(sessionId);
				},
				openAudioModels() {
					ctx.layout.selectPanel("model-library");
				}
			};
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: VOICE_PANEL_ID,
				locale: NS,
				inject: () => ({ voicePage: voiceFace })
			}, VoicePage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: VOICE_PANEL_ID,
				order: 55,
				label: () => ctx.locale.bind(NS)("voiceNav")
			}, VoiceIcon));
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