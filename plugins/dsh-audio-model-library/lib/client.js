window.__ModuleLoader__.load({
	id: "dsh-audio-model-library",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/store.ts
		/**
		* Shared browser store for the model library document (CONTRACT §3). Relative URLs work on Web
		* (`http://…/api`) and Desktop (`dsh-app://app/api`). The store never contacts a model server or
		* the GPU controller itself: every action is a host route, and only explicit user actions call
		* `refresh`/`activate`/`cancel`/`deactivate`.
		*/
		const API = "/api/dsh-audio-model-library/v1";
		var ActionError = class extends Error {
			code;
			extra;
			constructor(code, message, extra = {}) {
				super(message);
				this.code = code;
				this.extra = extra;
			}
		};
		async function post(path, body) {
			const response = await fetch(`${API}/${path}`, {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			const json = await response.json().catch(() => void 0);
			if (!response.ok || json?.ok === false) {
				const { code, message, ...extra } = json?.error ?? {};
				throw new ActionError(String(code ?? `HTTP_${response.status}`), String(message ?? `HTTP ${response.status}`), extra);
			}
			return json;
		}
		var LibraryStore = class {
			snapshot = {
				status: "loading",
				doc: null,
				busy: {},
				lastError: null
			};
			listeners = /* @__PURE__ */ new Set();
			feed;
			cursor;
			disposed = false;
			reloadTimer;
			getSnapshot = () => this.snapshot;
			subscribe = (listener) => {
				this.listeners.add(listener);
				if (this.listeners.size === 1) this.openFeed();
				return () => {
					this.listeners.delete(listener);
					if (this.listeners.size === 0) this.closeFeed();
				};
			};
			dispose() {
				this.disposed = true;
				this.closeFeed();
				this.listeners.clear();
			}
			publish(patch) {
				if (this.disposed) return;
				this.snapshot = {
					...this.snapshot,
					...patch
				};
				for (const listener of this.listeners) listener();
			}
			/** Cached host state only; contacts no server. */
			async load() {
				try {
					const response = await fetch(`${API}/library`, { credentials: "include" });
					if (response.status === 404) {
						this.publish({
							status: "absent",
							doc: null
						});
						return;
					}
					if (!response.ok) {
						this.publish({
							status: "error",
							message: `HTTP ${response.status}`
						});
						return;
					}
					this.publish({
						status: "ready",
						doc: await response.json()
					});
				} catch (error) {
					this.publish({
						status: "error",
						message: error instanceof Error ? error.message : String(error)
					});
				}
			}
			scheduleLoad() {
				if (this.reloadTimer !== void 0) return;
				this.reloadTimer = setTimeout(() => {
					this.reloadTimer = void 0;
					this.load();
				}, 120);
			}
			openFeed() {
				if (this.feed !== void 0 || this.disposed) return;
				const controller = new AbortController();
				this.feed = controller;
				(async () => {
					let backoff = 500;
					while (!controller.signal.aborted) {
						try {
							const url = `${API}/events${this.cursor === void 0 ? "" : `?after=${this.cursor}`}`;
							const response = await fetch(url, {
								credentials: "include",
								signal: controller.signal
							});
							if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
							backoff = 500;
							const reader = response.body.getReader();
							const decoder = new TextDecoder();
							let buffer = "";
							for (;;) {
								const { value, done } = await reader.read();
								if (done) break;
								buffer += decoder.decode(value, { stream: true });
								let newline = buffer.indexOf("\n");
								while (newline >= 0) {
									const line = buffer.slice(0, newline).trim();
									buffer = buffer.slice(newline + 1);
									newline = buffer.indexOf("\n");
									if (line === "") continue;
									const event = JSON.parse(line);
									if (typeof event.cursor === "number") this.cursor = event.cursor;
									if (event.type !== "ping") this.scheduleLoad();
								}
							}
						} catch {
							if (controller.signal.aborted) return;
						}
						await new Promise((resolve) => setTimeout(resolve, backoff));
						backoff = Math.min(backoff * 2, 1e4);
					}
				})();
				this.load();
			}
			closeFeed() {
				this.feed?.abort();
				this.feed = void 0;
			}
			async run(key, action) {
				this.publish({
					busy: {
						...this.snapshot.busy,
						[key]: true
					},
					lastError: null
				});
				try {
					const result = await action();
					await this.load();
					return result;
				} catch (error) {
					const failure = error instanceof ActionError ? {
						code: error.code,
						message: error.message,
						extra: error.extra
					} : {
						code: "NETWORK",
						message: error instanceof Error ? error.message : String(error)
					};
					this.publish({ lastError: failure });
					await this.load();
					return;
				} finally {
					const busy = { ...this.snapshot.busy };
					delete busy[key];
					this.publish({ busy });
				}
			}
			refresh(serverId) {
				return this.run(`refresh:${serverId ?? "*"}`, () => post("refresh", serverId ? { serverId } : {}));
			}
			activate(body) {
				return this.run(`activate:${body.serverId}`, () => post("activate", body));
			}
			bind(body) {
				return this.run(`bind:${body.serverId}`, () => post("bind", body));
			}
			cancel(serverId, jobId) {
				return this.run(`cancel:${serverId}`, () => post("cancel", {
					serverId,
					jobId
				}));
			}
			deactivate(serverId, recipeId) {
				return this.run(`deactivate:${serverId}`, () => post("deactivate", {
					serverId,
					recipeId
				}));
			}
			clearError() {
				this.publish({ lastError: null });
			}
		};
		/** Library-managed provider → recipe/model view (for the composer chip). */
		function findLibraryModel(doc, provider, model) {
			if (doc === null) return void 0;
			for (const row of doc.rows) for (const recipe of row.recipes) if (recipe.provider === provider && (recipe.models.some((m) => m.id === model) || model.startsWith(`${recipe.recipeId}--`))) return {
				row,
				recipe
			};
		}
		//#endregion
		//#region src/client/service.ts
		/**
		* Client service `audioModelLibrary` (CONTRACT §6.1) for other plugins, e.g. dsh-voice-capture's
		* task UI (TASK_UI_CONTRACT_PROPOSAL §D): observable activation state per Harness model id, plus
		* opening the library for a conversation. It never activates anything by itself.
		*/
		const ACTIVE_JOB = new Set([
			"queued",
			"preflight",
			"draining",
			"stopping",
			"starting",
			"loading",
			"verifying",
			"restoring"
		]);
		/** Pure derivation (unit-tested): library document → activation state of one model id. */
		function activationState(doc, provider, model) {
			if (doc === null) return { state: "unknown" };
			const found = findLibraryModel(doc, provider, model);
			if (found === void 0) return doc.rows.some((row) => row.staticRoutes.some((route) => route.provider === provider && route.model === model)) ? { state: "static" } : { state: "unknown" };
			const { recipe } = found;
			const server = doc.servers.find((s) => s.id === recipe.serverId);
			const job = server?.job ?? null;
			if (job !== null && ACTIVE_JOB.has(job.phase)) {
				if (job.kind === "activate" && job.recipeId === recipe.recipeId) {
					if (job.phase === "queued" || job.phase === "preflight" || job.phase === "draining") return {
						state: "queued",
						detail: job.phase
					};
					return {
						state: "loading",
						detail: job.phase
					};
				}
				if ((job.previous ?? []).includes(recipe.recipeId) || job.kind === "deactivate" && job.recipeId === recipe.recipeId) return {
					state: "stopping",
					detail: job.phase
				};
			}
			const entry = recipe.models.find((m) => m.id === model);
			if (recipe.usable && entry?.liveOnly === true && (recipe.busy?.requests ?? 0) > 0) return {
				state: "busy",
				reason: "turn-running",
				detail: `${recipe.busy?.requests} request(s) running on ${recipe.recipeId}`
			};
			if (recipe.usable) return {
				state: "ready",
				since: server?.controller.checkedAt ?? (/* @__PURE__ */ new Date(0)).toISOString()
			};
			if (job !== null && job.recipeId === recipe.recipeId && (job.phase === "failed" || job.phase === "refused") && job.error) return {
				state: "error",
				code: job.error.code,
				message: job.error.message
			};
			if (server?.switching && server.switching.allowed === false) return {
				state: "busy",
				reason: "benchmark-reservation",
				detail: server.switching.reason ?? server.switching.code ?? void 0
			};
			if (server?.bindingError) return {
				state: "error",
				code: server.bindingError.code,
				message: server.bindingError.message
			};
			return {
				state: "cold",
				detail: recipe.healthy ? "running-not-bound" : "not-loaded"
			};
		}
		function createFace(store, open) {
			const cache = /* @__PURE__ */ new Map();
			return {
				contractVersion: "0.1",
				status(provider, model) {
					const id = `${provider} ${model}`;
					return {
						getSnapshot() {
							const next = activationState(store.getSnapshot().doc, provider, model);
							const key = JSON.stringify(next);
							const previous = cache.get(id);
							if (previous !== void 0 && previous.key === key) return previous.value;
							cache.set(id, {
								value: next,
								key
							});
							return next;
						},
						subscribe: (listener) => store.subscribe(listener)
					};
				},
				document() {
					return {
						getSnapshot: () => store.getSnapshot().doc,
						subscribe: (listener) => store.subscribe(listener)
					};
				},
				open
			};
		}
		//#endregion
		//#region src/client/locale.ts
		/** Copy for the model library surfaces (namespace `audioModelLibrary`). */
		const NS = "audioModelLibrary";
		const en = {
			navLabel: "Audio models",
			title: "Audio model library",
			subtitle: "Every audio model in the catalog, including models that are not loaded. Choose a task, activate the model on your server, then use it in a conversation.",
			notInstalled: "The model library host plugin is not running in this deployment.",
			loading: "Reading the library…",
			loadFailed: "Could not read the library: {message}",
			noServer: "No server yet. Add your GPU server in Settings → Plugins → Audio model library.",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			refreshHint: "Asks your server for its catalog, recipes and running models. Nothing is loaded or stopped.",
			server: "Server",
			controllerNone: "Static endpoints (activation is managed by the server administrator)",
			controllerUnknown: "Not checked yet",
			controllerChecking: "Checking…",
			controllerReachable: "Controller reachable",
			controllerUnreachable: "Controller unreachable: {message}",
			switchingBlocked: "Switching is paused: {reason}",
			foreign: "Another GPU workload is running: {names}",
			catalogLine: "Catalog {version} · {completeness} · {count} rows",
			catalogIncomplete: "The catalog is still being completed; more models will appear.",
			catalogMissing: "No catalog loaded yet.",
			adapterMissing: "dsh-dgx-audio is not installed, so models cannot be used in conversations.",
			adapterLegacy: "Audio adapter 0.3: speech synthesis, translation, generation and non-duplex live modes are shown but cannot be used yet.",
			search: "Search models, repositories, families, tasks",
			filterTask: "Task",
			filterLifecycle: "Status",
			filterDownload: "Download",
			filterResidency: "On server",
			filterEngine: "Runtime",
			filterStreaming: "Streaming",
			filterEvidence: "Evidence",
			showAssets: "Show auxiliary assets",
			any: "Any",
			results: "{count} of {total} models",
			noMatch: "No model matches these filters.",
			colModel: "Model",
			colTasks: "Tasks",
			colStatus: "Status",
			colDownload: "Download",
			colServer: "On server",
			colEvidence: "Evidence",
			residencyActive: "Running",
			residencyLoading: "Starting",
			residencyCold: "Not loaded",
			residencyNoRecipe: "No recipe",
			residencyStatic: "Configured endpoint",
			backend: "Backend",
			desktop: "Desktop",
			evidencePass: "pass",
			evidenceFail: "fail",
			evidenceBlocked: "blocked",
			capUnsupportedReviewed: "unsupported (reviewed)",
			evidenceUnverified: "unverified",
			unknown: "unknown",
			notInCatalog: "not in catalog",
			details: "Details",
			close: "Close",
			identity: "Identity",
			repository: "Repository",
			revision: "Revision",
			license: "License",
			access: "Access",
			prerequisite: "Prerequisite",
			architecture: "Architecture",
			testedImage: "Tested image",
			hardware: "Capacity",
			modalities: "Input → output",
			streamingModes: "Streaming modes",
			runtimeSupport: "runtime",
			endpoints: "Catalog endpoints",
			dependencies: "Dependencies",
			sources: "Sources",
			notes: "Notes",
			runtimes: "Runtimes on your server",
			noRecipes: "Your server has no recipe for this model yet.",
			chooseTasks: "Tasks to enable",
			taskUnavailable: "Unavailable: {reason}",
			reason_NO_RECIPE: "no recipe on the server",
			reason_NO_ENDPOINT_FOR_TASK: "this runtime does not serve the task",
			reason_ADAPTER_MODE_UNSUPPORTED: "the installed audio adapter cannot use this protocol yet",
			reason_SAMPLE_RATE_UNKNOWN: "input/output sample rate is not known",
			reason_NO_ADAPTER_TASK: "no Harness surface for this task yet",
			reason_RECIPE_INCOMPLETE: "the recipe has no port or served model",
			reason_WIRE_NOT_IMPLEMENTED: "the catalog names a protocol the installed audio adapter does not implement",
			reason_WIRE_MODE_MISMATCH: "the catalog protocol does not match the adapter mode of this task",
			reason_ALIGN_CONFIG_MISSING: "alignment needs align.timestampSegmentTime from the checkpoint config",
			reason_HOST_REFUSED: "the audio adapter refused this runtime configuration",
			taskDeclaredOnly: "Declared by the catalog, not verified on DGX: no backend or Desktop pass is recorded for this task. A ready runtime here is not a capability pass.",
			requestOptionsDeclared: "{count} request options declared by the catalog (listed by source, not verified for this model)",
			requestOptionStatuses: "catalog statuses: {statuses}",
			resultScope: "Result scope",
			weightsLine: "{precision} · {method} · base {base} ({relation})",
			runtimeDefects: "Runtime defects",
			dependencyOpen: "{count} required dependencies not verified complete",
			rateCorrections: "Owner rate corrections",
			rateCorrectionLine: "{metric} ({scope} {key}, {layer}): {value}. {note}. Raw data: {rawPolicy} ({items} items, correction file sha256 {sha})",
			activate: "Activate",
			activateHint: "Stops the model currently loaded on this server (when idle), loads this one and checks health.",
			activating: "Activating…",
			alreadyRunning: "Running",
			useHere: "Use in this conversation",
			useHint: "Selects {model} for the current conversation.",
			useDone: "Selected {model}.",
			noTarget: "Open a conversation first, then choose “Audio models” from its composer.",
			deactivate: "Unload",
			cancel: "Cancel",
			confirmCancelRunning: "Cancel the running audio turn and switch",
			jobTitle: "{kind} {recipe}",
			phase_queued: "Queued",
			phase_preflight: "Checking reservations and GPU use",
			phase_draining: "Waiting for running audio to finish",
			phase_stopping: "Stopping the previous model",
			phase_starting: "Starting container",
			phase_loading: "Loading weights",
			phase_verifying: "Checking health and model list",
			phase_restoring: "Restoring the previous model",
			phase_ready: "Ready",
			phase_stopped: "Unloaded",
			phase_failed: "Failed",
			phase_cancelled: "Cancelled",
			phase_refused: "Refused",
			elapsed: "{elapsed} elapsed · usually about {typical}",
			elapsedOnly: "{elapsed} elapsed",
			restoredOk: "The previous model {recipe} was restored.",
			restoredFail: "The previous model {recipe} could not be restored.",
			errorLine: "{code}: {message}",
			logTail: "Server log excerpt",
			busyConnections: "Open connections: {detail}",
			contactLost: "Lost contact with the controller; retrying.",
			bindingState_bound: "In use",
			bindingState_switching: "Switching",
			bindingState_stale: "Not running on the server any more",
			models: "Harness models",
			sampleRates: "{input} Hz in · {output} Hz out",
			referenceMissing: "needs a voice prompt (set one in Settings)",
			liveOnly: "Live only — not a chat model. Select a chat model of this runtime, then start Live from the composer.",
			busyRunning: "{count} audio request(s) running on this runtime",
			chipLiveOnly: "{model} is live-only — choose a chat model",
			roleAv: "audio + video generation",
			evidenceDetails: "Evidence, speed and owner notes",
			functionVsSpeed: "Function and speed are reported separately. These notes are information only; the library does not block a model because of them.",
			summaryLine: "Tasks {tasks} · streaming modes {modes} · row complete: {complete}",
			colTask: "Task",
			colNotes: "Notes",
			speed: "Speed",
			speedBelowRealtime: "Below real time",
			speedBasisNote: "from the note text of the {source} (not a measured factor)",
			speedMetricLine: "{metric} = {value} {unit} ({formula})",
			speedClass_below: "slower than real time",
			speedClass_above: "keeps up with real time",
			speedClass_mixed: "range crosses real time",
			speedClass_unclassified: "direction not defined by the source; shown as reported, not classified",
			speedClass_latency: "latency (not compared with real time)",
			speedKind: "{kind} measurement",
			speedRaw: "source label: {label} {value}",
			speedNone: "No speed evidence recorded.",
			ownerNotes: "Server owner notes",
			badgeBelowRealtime: "below real time",
			badgeOwnerNotes: "owner notes",
			sourceCatalog: "catalog evidence",
			sourceRecipe: "server recipe",
			yes: "yes",
			no: "no",
			roleAsset: "auxiliary asset (not selectable)",
			filterRole: "Kind",
			chipLabel: "Audio models",
			chipModelState: "{model}: {state}",
			chipOpen: "Open the audio model library for this conversation",
			stateReady: "ready",
			stateCold: "not loaded",
			stateLoading: "loading",
			stateStale: "not running",
			cardTitle: "Audio model library",
			cardDescription: "GPU servers whose audio models you can browse, activate and switch.",
			cardEmpty: "No server yet.",
			fieldName: "Name",
			fieldId: "Identifier",
			fieldModelHost: "Model host",
			fieldModelHostHint: "Host name or IP address this computer uses to reach the model ports.",
			fieldMode: "Activation",
			modeNone: "None — use endpoints configured by the administrator",
			modeSsh: "SSH (uses your existing SSH access)",
			modeHttp: "Private controller endpoint",
			fieldSshDestination: "SSH host or alias",
			fieldSshDestinationHint: "As you would type after “ssh”. Keys stay in your own SSH setup.",
			fieldSshCommand: "Controller command on the server",
			fieldHttpUrl: "Controller URL",
			fieldTokenEnv: "Token environment variable",
			fieldTokenEnvHint: "Only the variable name is stored.",
			fieldCatalogFile: "Catalog file (optional)",
			fieldCatalogFileHint: "Absolute path of an audio catalog JSON file, used when the controller has none.",
			fieldApiKeyEnv: "Model API key variable (optional)",
			add: "Add server",
			remove: "Remove",
			saving: "Saving…",
			saved: "Saved.",
			saveFailed: "Could not save: {message}",
			check: "Check controller",
			invalid: "Check the highlighted fields.",
			readOnly: "These settings are read-only in this deployment."
		};
		const zh = {
			navLabel: "音频模型",
			title: "音频模型库",
			subtitle: "目录中的全部音频模型，包括尚未加载的模型。选择任务，在服务器上启用模型，然后在对话中使用。",
			notInstalled: "此部署中未运行模型库宿主插件。",
			loading: "正在读取模型库…",
			loadFailed: "无法读取模型库：{message}",
			noServer: "还没有服务器。请在 设置 → 插件 → 音频模型库 中添加 GPU 服务器。",
			refresh: "刷新",
			refreshing: "刷新中…",
			refreshHint: "向服务器读取目录、配方和运行中的模型。不会加载或停止任何模型。",
			server: "服务器",
			controllerNone: "静态端点（由服务器管理员管理启用）",
			controllerUnknown: "尚未检查",
			controllerChecking: "检查中…",
			controllerReachable: "控制器可连接",
			controllerUnreachable: "无法连接控制器：{message}",
			switchingBlocked: "暂停切换：{reason}",
			foreign: "另一项 GPU 工作正在运行：{names}",
			catalogLine: "目录 {version} · {completeness} · {count} 行",
			catalogIncomplete: "目录仍在补全中，之后会出现更多模型。",
			catalogMissing: "尚未加载目录。",
			adapterMissing: "未安装 dsh-dgx-audio，无法在对话中使用模型。",
			adapterLegacy: "音频适配器 0.3：语音合成、翻译、生成与非双工实时模式会显示，但暂时无法使用。",
			search: "搜索模型、仓库、系列、任务",
			filterTask: "任务",
			filterLifecycle: "状态",
			filterDownload: "下载",
			filterResidency: "服务器上",
			filterEngine: "运行时",
			filterStreaming: "流式",
			filterEvidence: "证据",
			showAssets: "显示辅助资产",
			any: "全部",
			results: "{total} 个模型中的 {count} 个",
			noMatch: "没有符合筛选条件的模型。",
			colModel: "模型",
			colTasks: "任务",
			colStatus: "状态",
			colDownload: "下载",
			colServer: "服务器上",
			colEvidence: "证据",
			residencyActive: "运行中",
			residencyLoading: "启动中",
			residencyCold: "未加载",
			residencyNoRecipe: "无配方",
			residencyStatic: "已配置端点",
			backend: "后端",
			desktop: "桌面",
			evidencePass: "通过",
			evidenceFail: "失败",
			evidenceBlocked: "受阻",
			capUnsupportedReviewed: "不支持（已审核）",
			evidenceUnverified: "未验证",
			unknown: "未知",
			notInCatalog: "目录未提供",
			details: "详情",
			close: "关闭",
			identity: "身份",
			repository: "仓库",
			revision: "版本",
			license: "许可证",
			access: "访问",
			prerequisite: "前提条件",
			architecture: "架构",
			testedImage: "测试镜像",
			hardware: "容量",
			modalities: "输入 → 输出",
			streamingModes: "流式模式",
			runtimeSupport: "运行时",
			endpoints: "目录端点",
			dependencies: "依赖",
			sources: "来源",
			notes: "备注",
			runtimes: "你服务器上的运行时",
			noRecipes: "你的服务器还没有此模型的配方。",
			chooseTasks: "要启用的任务",
			taskUnavailable: "不可用：{reason}",
			reason_NO_RECIPE: "服务器上没有配方",
			reason_NO_ENDPOINT_FOR_TASK: "此运行时不提供该任务",
			reason_ADAPTER_MODE_UNSUPPORTED: "已安装的音频适配器暂不支持此协议",
			reason_SAMPLE_RATE_UNKNOWN: "输入/输出采样率未知",
			reason_NO_ADAPTER_TASK: "Harness 暂无此任务的界面",
			reason_RECIPE_INCOMPLETE: "配方缺少端口或模型名",
			reason_WIRE_NOT_IMPLEMENTED: "目录中的协议未被已安装的音频适配器实现",
			reason_WIRE_MODE_MISMATCH: "目录协议与此任务的适配器模式不符",
			reason_ALIGN_CONFIG_MISSING: "对齐需要检查点配置中的 align.timestampSegmentTime",
			reason_HOST_REFUSED: "音频适配器拒绝了此运行时配置",
			taskDeclaredOnly: "目录已声明，未在 DGX 实测：此任务没有后端或桌面端通过记录。这里的运行时就绪不等于能力通过。",
			requestOptionsDeclared: "目录声明了 {count} 个请求选项（来源列出，未针对此模型验证）",
			requestOptionStatuses: "目录状态：{statuses}",
			resultScope: "结果适用范围",
			weightsLine: "{precision} · {method} · 基础 {base}（{relation}）",
			runtimeDefects: "运行时缺陷",
			dependencyOpen: "{count} 个必需依赖未验证完整",
			rateCorrections: "所有者速率更正",
			rateCorrectionLine: "{metric}（{scope} {key}，{layer}）：{value}。{note}。原始数据：{rawPolicy}（{items} 项，更正文件 sha256 {sha}）",
			activate: "启用",
			activateHint: "在空闲时停止此服务器上当前加载的模型，加载此模型并检查健康状态。",
			activating: "启用中…",
			alreadyRunning: "运行中",
			useHere: "在此对话中使用",
			useHint: "为当前对话选择 {model}。",
			useDone: "已选择 {model}。",
			noTarget: "请先打开一个对话，再从输入框选择“音频模型”。",
			deactivate: "卸载",
			cancel: "取消",
			confirmCancelRunning: "取消正在进行的音频回合并切换",
			jobTitle: "{kind} {recipe}",
			phase_queued: "排队中",
			phase_preflight: "检查预约和 GPU 使用",
			phase_draining: "等待正在进行的音频结束",
			phase_stopping: "停止上一个模型",
			phase_starting: "启动容器",
			phase_loading: "加载权重",
			phase_verifying: "检查健康状态和模型列表",
			phase_restoring: "恢复上一个模型",
			phase_ready: "就绪",
			phase_stopped: "已卸载",
			phase_failed: "失败",
			phase_cancelled: "已取消",
			phase_refused: "已拒绝",
			elapsed: "已用 {elapsed} · 通常约 {typical}",
			elapsedOnly: "已用 {elapsed}",
			restoredOk: "已恢复上一个模型 {recipe}。",
			restoredFail: "无法恢复上一个模型 {recipe}。",
			errorLine: "{code}：{message}",
			logTail: "服务器日志摘录",
			busyConnections: "仍有连接：{detail}",
			contactLost: "与控制器失去联系，正在重试。",
			bindingState_bound: "使用中",
			bindingState_switching: "切换中",
			bindingState_stale: "服务器上已不再运行",
			models: "Harness 模型",
			sampleRates: "输入 {input} Hz · 输出 {output} Hz",
			referenceMissing: "需要声音提示（在设置中指定）",
			liveOnly: "仅实时 — 不是对话模型。请选择此运行时的对话模型，再从输入框启动实时模式。",
			busyRunning: "此运行时有 {count} 个音频请求正在进行",
			chipLiveOnly: "{model} 仅支持实时 — 请选择对话模型",
			roleAv: "音视频生成",
			evidenceDetails: "证据、速度与服务器维护者备注",
			functionVsSpeed: "功能与速度分开显示。这些备注仅供参考；模型库不会因此阻止使用模型。",
			summaryLine: "任务 {tasks} · 流式模式 {modes} · 整行完成：{complete}",
			colTask: "任务",
			colNotes: "备注",
			speed: "速度",
			speedBelowRealtime: "低于实时",
			speedBasisNote: "来自{source}的备注文字（不是测得的倍率）",
			speedMetricLine: "{metric} = {value} {unit}（{formula}）",
			speedClass_below: "慢于实时",
			speedClass_above: "可跟上实时",
			speedClass_mixed: "范围跨越实时",
			speedClass_unclassified: "来源未定义方向；按原样显示，不做判断",
			speedClass_latency: "延迟（不与实时比较）",
			speedKind: "{kind} 测量",
			speedRaw: "来源标签：{label} {value}",
			speedNone: "没有记录速度证据。",
			ownerNotes: "服务器维护者备注",
			badgeBelowRealtime: "低于实时",
			badgeOwnerNotes: "维护者备注",
			sourceCatalog: "目录证据",
			sourceRecipe: "服务器配方",
			yes: "是",
			no: "否",
			roleAsset: "辅助资产（不可选择）",
			filterRole: "类型",
			chipLabel: "音频模型",
			chipModelState: "{model}：{state}",
			chipOpen: "为此对话打开音频模型库",
			stateReady: "就绪",
			stateCold: "未加载",
			stateLoading: "加载中",
			stateStale: "未运行",
			cardTitle: "音频模型库",
			cardDescription: "可浏览、启用和切换音频模型的 GPU 服务器。",
			cardEmpty: "还没有服务器。",
			fieldName: "名称",
			fieldId: "标识",
			fieldModelHost: "模型主机",
			fieldModelHostHint: "本机访问模型端口所用的主机名或 IP 地址。",
			fieldMode: "启用方式",
			modeNone: "无 — 使用管理员配置的端点",
			modeSsh: "SSH（使用你现有的 SSH 访问）",
			modeHttp: "私有控制器端点",
			fieldSshDestination: "SSH 主机或别名",
			fieldSshDestinationHint: "即 “ssh” 后面输入的内容。密钥保留在你自己的 SSH 配置中。",
			fieldSshCommand: "服务器上的控制器命令",
			fieldHttpUrl: "控制器 URL",
			fieldTokenEnv: "令牌环境变量",
			fieldTokenEnvHint: "只保存变量名称。",
			fieldCatalogFile: "目录文件（可选）",
			fieldCatalogFileHint: "音频目录 JSON 文件的绝对路径，控制器没有目录时使用。",
			fieldApiKeyEnv: "模型 API 密钥变量（可选）",
			add: "添加服务器",
			remove: "移除",
			saving: "保存中…",
			saved: "已保存。",
			saveFailed: "无法保存：{message}",
			check: "检查控制器",
			invalid: "请检查标出的字段。",
			readOnly: "此部署中的这些设置为只读。"
		};
		function format(text, values = {}) {
			return text.replaceAll(/\{([^{}]+)\}/gu, (placeholder, key) => values[key] === void 0 ? placeholder : String(values[key]));
		}
		function duration(seconds) {
			if (!Number.isFinite(seconds) || seconds < 0) return "?";
			if (seconds < 90) return `${Math.round(seconds)} s`;
			const minutes = Math.floor(seconds / 60);
			return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
		}
		function bytes(value) {
			if (value === null) return "";
			const gib = value / 1024 ** 3;
			return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${(value / 1024 ** 2).toFixed(0)} MiB`;
		}
		//#endregion
		//#region \0dsh-css:packages/third-party/dsh-audio-model-library/src/client/library.module.css.mjs
		const css = ".lUdDjW_page{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);padding:20px 24px 40px;font-size:13px;overflow:auto;container-type:inline-size}.lUdDjW_header{justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px;display:flex}.lUdDjW_title{margin:0 0 4px;font-size:20px;font-weight:600}.lUdDjW_target{color:var(--dsw-alias-brand-primary);margin:6px 0 0;font-size:12px}.lUdDjW_muted{color:var(--dsw-alias-label-tertiary);font-size:12px}.lUdDjW_ok{color:var(--dsw-alias-label-secondary);font-size:12px}.lUdDjW_bad{color:var(--dsw-alias-label-error,var(--dsw-alias-label-tertiary));overflow-wrap:anywhere;font-size:12px}.lUdDjW_empty{border:.5px dashed var(--dsw-alias-border-l4);border-radius:12px;padding:16px}.lUdDjW_h3{margin:16px 0 6px;font-size:13px;font-weight:600}.lUdDjW_label{color:var(--dsw-alias-label-tertiary);font-size:11px}.lUdDjW_code{font-family:var(--dsw-font-mono,ui-monospace, monospace);word-break:break-all;font-size:11px}.lUdDjW_pre{white-space:pre-wrap;max-height:200px;font-size:11px;overflow:auto}.lUdDjW_plain{gap:4px;margin:0;padding:0;list-style:none;display:grid}.lUdDjW_primary,.lUdDjW_secondary,.lUdDjW_ghost{height:28px;font:inherit;cursor:pointer;white-space:nowrap;border-radius:8px;padding:0 12px;font-size:12px}.lUdDjW_primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:0}.lUdDjW_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.lUdDjW_secondary{border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:0 0}.lUdDjW_secondary:hover:not(:disabled),.lUdDjW_ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.lUdDjW_ghost{color:var(--dsw-alias-label-tertiary);background:0 0;border:0}.lUdDjW_primary:disabled,.lUdDjW_secondary:disabled,.lUdDjW_ghost:disabled{opacity:.4;cursor:not-allowed}.lUdDjW_primary:focus-visible,.lUdDjW_secondary:focus-visible,.lUdDjW_ghost:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.lUdDjW_server{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);border-radius:12px;margin:8px 0;padding:10px 12px}.lUdDjW_serverHead{flex-wrap:wrap;align-items:baseline;gap:12px;display:flex}.lUdDjW_job{background:var(--dsw-alias-bg-layer-3);border-radius:10px;margin-top:8px;padding:8px 10px}.lUdDjW_jobBad{border:.5px solid var(--dsw-alias-label-error,var(--dsw-alias-border-l3))}.lUdDjW_jobHead{flex-wrap:wrap;align-items:center;gap:10px;display:flex}.lUdDjW_phase{font-weight:600}.lUdDjW_steps{flex-wrap:wrap;gap:6px;margin:8px 0 0;padding:0;list-style:none;display:flex}.lUdDjW_step,.lUdDjW_stepDone,.lUdDjW_stepNow{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:2px 8px;font-size:11px}.lUdDjW_stepDone{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}.lUdDjW_stepNow{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}.lUdDjW_error{background:var(--dsw-alias-bg-layer-3);border-radius:10px;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:12px;margin:8px 0;padding:8px 10px;display:flex}.lUdDjW_error p{margin:0}.lUdDjW_filters{flex-wrap:wrap;align-items:end;gap:8px;margin:14px 0 8px;display:flex}.lUdDjW_search{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);min-width:200px;height:30px;color:inherit;font:inherit;border-radius:8px;flex:100%;padding:0 10px}.lUdDjW_filter{gap:2px;display:grid}.lUdDjW_select{max-width:240px}.lUdDjW_select,.lUdDjW_input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:28px;color:inherit;font:inherit;box-sizing:border-box;border-radius:8px;padding:0 8px;font-size:12px}.lUdDjW_inputBad{border-color:var(--dsw-alias-label-error,var(--dsw-alias-label-primary))}.lUdDjW_check{align-items:center;gap:6px;font-size:12px;display:inline-flex}.lUdDjW_body{grid-template-columns:minmax(0,1fr);gap:12px;display:grid}@container (width>=1100px){.lUdDjW_body{grid-template-columns:minmax(0,1.4fr) minmax(360px,1fr);align-items:start}}.lUdDjW_list{border-collapse:collapse;width:100%}.lUdDjW_list th{text-align:left;color:var(--dsw-alias-label-tertiary);border-bottom:.5px solid var(--dsw-alias-border-l4);padding:6px;font-size:11px;font-weight:500}.lUdDjW_list td{vertical-align:top;border-bottom:.5px solid var(--dsw-alias-border-l5,var(--dsw-alias-border-l4));padding:6px}.lUdDjW_row,.lUdDjW_rowOn{cursor:pointer}.lUdDjW_row:hover{background:var(--dsw-alias-bg-layer-2)}.lUdDjW_rowOn{background:var(--dsw-alias-bg-layer-3)}.lUdDjW_row:focus-visible,.lUdDjW_rowOn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.lUdDjW_rowName{font-weight:500}.lUdDjW_chips{flex-wrap:wrap;gap:4px;display:flex}.lUdDjW_chip{border:.5px dashed var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 6px;font-size:11px}.lUdDjW_chipOn{color:var(--dsw-alias-label-secondary);border-style:solid}.lUdDjW_badge{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:11px}.lUdDjW_badgeOk{border:.5px solid var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);background:0 0}.lUdDjW_detail{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);border-radius:14px;min-width:0;padding:12px 14px;position:sticky;top:0}.lUdDjW_detailHead{justify-content:space-between;align-items:center;gap:8px;display:flex}.lUdDjW_detailTitle{margin:0;font-size:16px}.lUdDjW_facts{grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:10px 0;display:grid}.lUdDjW_facts dt{color:var(--dsw-alias-label-tertiary);font-size:12px}.lUdDjW_facts dd{overflow-wrap:anywhere;min-width:0;margin:0;font-size:12px}.lUdDjW_table{border-collapse:collapse;width:100%;font-size:12px}.lUdDjW_table td{border-bottom:.5px solid var(--dsw-alias-border-l4);vertical-align:top;padding:3px 4px}.lUdDjW_table td .lUdDjW_code{word-break:normal;overflow-wrap:normal;white-space:nowrap}.lUdDjW_table td:last-child{overflow-wrap:anywhere;min-width:16ch}.lUdDjW_recipes{gap:8px;margin:0;padding:0;list-style:none;display:grid}.lUdDjW_recipe{background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:10px}.lUdDjW_recipeHead{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.lUdDjW_recipeName{font-weight:600}.lUdDjW_tasks{border:0;gap:4px;margin:8px 0;padding:0;display:grid}.lUdDjW_task{flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;display:flex}.lUdDjW_taskOff{color:var(--dsw-alias-label-tertiary)}.lUdDjW_actions{flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;display:flex}.lUdDjW_models{gap:6px;margin:8px 0 0;padding:0;list-style:none;display:grid}.lUdDjW_model{flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;display:flex}.lUdDjW_chip,.lUdDjW_chipReady,.lUdDjW_chipBad{display:inline-flex}button.lUdDjW_chip{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:28px;color:var(--dsw-alias-label-primary);font:inherit;white-space:nowrap;cursor:pointer;text-overflow:ellipsis;border-radius:999px;align-items:center;gap:6px;max-width:320px;padding:0 10px;font-size:12px;overflow:hidden}.lUdDjW_chipDot{background:var(--dsw-alias-label-dimmed,#999);border-radius:50%;flex:none;width:6px;height:6px}.lUdDjW_chipReady .lUdDjW_chipDot{background:var(--dsw-alias-label-primary)}.lUdDjW_chipBad .lUdDjW_chipDot{background:var(--dsw-alias-label-error,var(--dsw-alias-label-tertiary))}.lUdDjW_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none}.lUdDjW_cardOpen{background:var(--dsw-alias-bg-layer-2)}.lUdDjW_cardHeader{appearance:none;width:100%;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;align-items:center;gap:12px;padding:14px 16px;display:flex}.lUdDjW_cardText{flex:1;gap:2px;min-width:0;display:grid}.lUdDjW_cardName{font-size:14px;font-weight:600}.lUdDjW_count{color:var(--dsw-alias-label-tertiary);font-size:12px}.lUdDjW_cardBody{gap:10px;padding:0 16px 16px;display:grid}.lUdDjW_serverRow{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.lUdDjW_form{gap:8px;display:grid}.lUdDjW_field{gap:3px;display:grid}.lUdDjW_hint{color:var(--dsw-alias-label-tertiary);font-size:11px}.lUdDjW_warn{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;font-size:12px}.lUdDjW_warnBadge{border:.5px solid var(--dsw-alias-label-error,var(--dsw-alias-label-primary));color:var(--dsw-alias-label-primary);white-space:nowrap;border-radius:999px;margin-top:2px;padding:1px 8px;font-size:11px;display:inline-block}.lUdDjW_ownerNote{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin:8px 0 0;font-size:12px}.lUdDjW_taskNote{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;flex-basis:100%;padding-left:22px;font-size:11px}.lUdDjW_scroll{overflow-x:auto}.lUdDjW_clamp{-webkit-line-clamp:3;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}";
		const tagId = "dsh-audio-model-library/library.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-audio-model-library";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var library_module_css_default = {
			"actions": "lUdDjW_actions",
			"bad": "lUdDjW_bad",
			"badge": "lUdDjW_badge",
			"badgeOk": "lUdDjW_badgeOk",
			"body": "lUdDjW_body",
			"card": "lUdDjW_card",
			"cardBody": "lUdDjW_cardBody",
			"cardHeader": "lUdDjW_cardHeader",
			"cardName": "lUdDjW_cardName",
			"cardOpen": "lUdDjW_cardOpen",
			"cardText": "lUdDjW_cardText",
			"check": "lUdDjW_check",
			"chip": "lUdDjW_chip",
			"chipBad": "lUdDjW_chipBad",
			"chipDot": "lUdDjW_chipDot",
			"chipOn": "lUdDjW_chipOn",
			"chipReady": "lUdDjW_chipReady",
			"chips": "lUdDjW_chips",
			"clamp": "lUdDjW_clamp",
			"code": "lUdDjW_code",
			"count": "lUdDjW_count",
			"detail": "lUdDjW_detail",
			"detailHead": "lUdDjW_detailHead",
			"detailTitle": "lUdDjW_detailTitle",
			"empty": "lUdDjW_empty",
			"error": "lUdDjW_error",
			"facts": "lUdDjW_facts",
			"field": "lUdDjW_field",
			"filter": "lUdDjW_filter",
			"filters": "lUdDjW_filters",
			"form": "lUdDjW_form",
			"ghost": "lUdDjW_ghost",
			"h3": "lUdDjW_h3",
			"header": "lUdDjW_header",
			"hint": "lUdDjW_hint",
			"input": "lUdDjW_input",
			"inputBad": "lUdDjW_inputBad",
			"job": "lUdDjW_job",
			"jobBad": "lUdDjW_jobBad",
			"jobHead": "lUdDjW_jobHead",
			"label": "lUdDjW_label",
			"list": "lUdDjW_list",
			"model": "lUdDjW_model",
			"models": "lUdDjW_models",
			"muted": "lUdDjW_muted",
			"ok": "lUdDjW_ok",
			"ownerNote": "lUdDjW_ownerNote",
			"page": "lUdDjW_page",
			"phase": "lUdDjW_phase",
			"plain": "lUdDjW_plain",
			"pre": "lUdDjW_pre",
			"primary": "lUdDjW_primary",
			"recipe": "lUdDjW_recipe",
			"recipeHead": "lUdDjW_recipeHead",
			"recipeName": "lUdDjW_recipeName",
			"recipes": "lUdDjW_recipes",
			"row": "lUdDjW_row",
			"rowName": "lUdDjW_rowName",
			"rowOn": "lUdDjW_rowOn",
			"scroll": "lUdDjW_scroll",
			"search": "lUdDjW_search",
			"secondary": "lUdDjW_secondary",
			"select": "lUdDjW_select",
			"server": "lUdDjW_server",
			"serverHead": "lUdDjW_serverHead",
			"serverRow": "lUdDjW_serverRow",
			"step": "lUdDjW_step",
			"stepDone": "lUdDjW_stepDone",
			"stepNow": "lUdDjW_stepNow",
			"steps": "lUdDjW_steps",
			"table": "lUdDjW_table",
			"target": "lUdDjW_target",
			"task": "lUdDjW_task",
			"taskNote": "lUdDjW_taskNote",
			"taskOff": "lUdDjW_taskOff",
			"tasks": "lUdDjW_tasks",
			"title": "lUdDjW_title",
			"warn": "lUdDjW_warn",
			"warnBadge": "lUdDjW_warnBadge"
		};
		//#endregion
		//#region src/client/LibraryChip.tsx
		/**
		* Composer chip (`conversation.input.left`): the activation state of the session's library-managed
		* model, or an "Audio models" entry once a server is configured. Clicking opens the library with
		* this conversation as the target. It never activates or selects anything by itself.
		*/
		function LibraryChip(props) {
			const t = (key, values) => format(props.t(key), values);
			const face = props.libraryChip;
			const snapshot = (0, react.useSyncExternalStore)(face.store.subscribe, face.store.getSnapshot);
			const selection = props.useProjection("modelSelection", (value) => value?.next ?? value?.lastUsed ?? null);
			const doc = snapshot.doc;
			if (doc === null || !doc.configured) return null;
			const found = selection === null ? void 0 : findLibraryModel(doc, selection.provider, selection.model);
			if (found === void 0 || selection === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: library_module_css_default.chip,
				title: t("chipOpen"),
				"aria-label": t("chipOpen"),
				onClick: () => {
					face.open({ sessionId: props.sessionId });
				},
				"data-testid": "library-chip",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: library_module_css_default.chipDot,
					"aria-hidden": "true"
				}), t("chipLabel")]
			});
			const model = found.recipe.models.find((m) => m.id === selection.model);
			if (model?.liveOnly === true) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: `${library_module_css_default.chip} ${library_module_css_default.chipBad}`,
				title: t("liveOnly"),
				onClick: () => {
					face.open({
						sessionId: props.sessionId,
						rowId: found.row.id
					});
				},
				"data-testid": "library-chip",
				"data-activation": "live-only",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: library_module_css_default.chipDot,
					"aria-hidden": "true"
				}), t("chipLiveOnly", { model: model.name ?? model.id })]
			});
			const activation = activationState(doc, selection.provider, selection.model);
			const stateText = activation.state === "ready" ? t("stateReady") : activation.state === "loading" || activation.state === "queued" ? t("stateLoading") : activation.state === "error" ? `${activation.code}` : activation.state === "busy" ? t("switchingBlocked", { reason: activation.detail ?? activation.reason }) : activation.state === "stopping" ? t("stateStale") : t("stateCold");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: `${library_module_css_default.chip} ${activation.state === "ready" ? library_module_css_default.chipReady : activation.state === "error" ? library_module_css_default.chipBad : ""}`,
				title: t("chipOpen"),
				onClick: () => {
					face.open({
						sessionId: props.sessionId,
						rowId: found.row.id
					});
				},
				"data-testid": "library-chip",
				"data-activation": activation.state,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: library_module_css_default.chipDot,
					"aria-hidden": "true"
				}), t("chipModelState", {
					model: model?.name ?? found.row.displayName,
					state: stateText
				})]
			});
		}
		//#endregion
		//#region src/client/LibraryView.tsx
		/**
		* Full-page audio model library (`main` key `model-library`, sidebar entry "Audio models").
		* Browsing is local; Refresh / Activate / Cancel / Unload are explicit actions through host routes.
		* Using a model in a conversation is the standard Session model selection.
		*/
		var NavStore = class {
			state = {
				sessionId: void 0,
				rowId: void 0
			};
			listeners = /* @__PURE__ */ new Set();
			getSnapshot = () => this.state;
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			set(patch) {
				this.state = {
					...this.state,
					...patch
				};
				for (const listener of this.listeners) listener();
			}
		};
		const PHASES = [
			"queued",
			"preflight",
			"draining",
			"stopping",
			"starting",
			"loading",
			"verifying",
			"ready"
		];
		const TERMINAL = new Set([
			"ready",
			"stopped",
			"failed",
			"cancelled",
			"refused"
		]);
		function evidenceLabel(t, state) {
			switch (state) {
				case "pass": return t("evidencePass");
				case "fail": return t("evidenceFail");
				case "blocked": return t("evidenceBlocked");
				case "unsupported_reviewed": return t("capUnsupportedReviewed");
				default: return t("evidenceUnverified");
			}
		}
		function residencyLabel(t, residency) {
			switch (residency) {
				case "active": return t("residencyActive");
				case "loading": return t("residencyLoading");
				case "cold": return t("residencyCold");
				case "static": return t("residencyStatic");
				default: return t("residencyNoRecipe");
			}
		}
		/** Only catalog/owner evidence counts; a mock or live runtime state never turns a declared task into a pass. */
		function taskHasPass(row, task) {
			const ev = row.taskAcceptance?.[task];
			return ev?.backend.state === "pass" || ev?.desktop.state === "pass";
		}
		function reasonLabel(t, reason) {
			const key = `reason_${reason}`;
			return reason === null ? "" : t(key) === key ? reason : t(key);
		}
		function unknownish(t, value) {
			if (value === null || value === void 0) return t("notInCatalog");
			return value === "unknown" ? t("unknown") : value;
		}
		function useNow(active) {
			const [now, setNow] = (0, react.useState)(() => Date.now());
			(0, react.useEffect)(() => {
				if (!active) return;
				const timer = setInterval(() => {
					setNow(Date.now());
				}, 1e3);
				return () => {
					clearInterval(timer);
				};
			}, [active]);
			return now;
		}
		function JobBanner({ t, server, store, snapshot }) {
			const job = server.job;
			const running = job !== null && !TERMINAL.has(job.phase);
			const now = useNow(running);
			if (job === null) return null;
			const started = Date.parse(job.createdAt ?? "");
			const elapsed = Number.isFinite(started) ? (now - started) / 1e3 : NaN;
			const reached = new Set(job.history.map((h) => h.phase));
			const stepIndex = PHASES.indexOf(job.phase === "restoring" ? "stopping" : job.phase);
			const title = format(t("jobTitle"), {
				kind: job.kind === "activate" ? t("activate") : t("deactivate"),
				recipe: job.recipeId
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: `${library_module_css_default.job} ${job.phase === "failed" || job.phase === "refused" ? library_module_css_default.jobBad : ""}`,
				"data-testid": "library-job",
				"data-phase": job.phase,
				"data-recipe": job.recipeId,
				"data-job": job.jobId,
				"data-kind": job.kind,
				"aria-live": "polite",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: library_module_css_default.jobHead,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: title }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: library_module_css_default.phase,
								children: t(`phase_${job.phase}`)
							}),
							running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: library_module_css_default.muted,
								children: job.typicalLoadSeconds ? format(t("elapsed"), {
									elapsed: duration(elapsed),
									typical: duration(job.typicalLoadSeconds)
								}) : format(t("elapsedOnly"), { elapsed: duration(elapsed) })
							}) : null,
							running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: library_module_css_default.ghost,
								disabled: snapshot.busy[`cancel:${server.id}`] === true,
								onClick: () => {
									store.cancel(server.id, job.jobId);
								},
								"data-testid": "library-job-cancel",
								children: t("cancel")
							}) : null
						]
					}),
					job.kind === "activate" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
						className: library_module_css_default.steps,
						children: PHASES.filter((phase) => running || reached.has(phase)).map((phase, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
							className: running && phase === job.phase ? library_module_css_default.stepNow : reached.has(phase) && (index < stepIndex || !running) ? library_module_css_default.stepDone : library_module_css_default.step,
							children: t(`phase_${phase}`)
						}, phase))
					}) : null,
					job.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: library_module_css_default.error,
						role: "alert",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: format(t("errorLine"), {
								code: job.error.code,
								message: job.error.message
							}) }),
							job.error.connections ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: format(t("busyConnections"), { detail: Object.entries(job.error.connections).map(([k, v]) => `${k}: ${v}`).join(", ") }) }) : null,
							job.error.logTail ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("logTail") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
								className: library_module_css_default.pre,
								children: job.error.logTail
							})] }) : null
						]
					}) : null,
					(job.restored ?? []).map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: item.ok ? library_module_css_default.ok : library_module_css_default.bad,
						children: format(t(item.ok ? "restoredOk" : "restoredFail"), { recipe: item.recipeId })
					}, item.recipeId))
				]
			});
		}
		function RecipeCard({ t, face, row, recipe, server, snapshot, adapterLegacy }) {
			const nav = (0, react.useSyncExternalStore)(face.nav.subscribe, face.nav.getSnapshot);
			const [chosen, setChosen] = (0, react.useState)(void 0);
			const [useStatus, setUseStatus] = (0, react.useState)("");
			const bindable = recipe.tasks.filter((task) => task.bindable).map((task) => task.id);
			const selected = chosen ?? bindable;
			const controllerMode = server?.controller.mode ?? "none";
			const jobRunning = server?.job !== null && server?.job !== void 0 && !TERMINAL.has(server.job.phase);
			const busyError = snapshot.lastError?.code === "LOCAL_BUSY";
			const activate = (confirmCancelRunning = false) => {
				face.store.activate({
					serverId: recipe.serverId,
					rowId: row.id,
					recipeId: recipe.recipeId,
					tasks: selected,
					...confirmCancelRunning ? { confirmCancelRunning } : {}
				});
			};
			const use = async (model) => {
				if (nav.sessionId === void 0) {
					setUseStatus(t("noTarget"));
					return;
				}
				const result = await face.selectModel(nav.sessionId, recipe.provider, model.id);
				setUseStatus(result.ok ? format(t("useDone"), { model: model.name ?? model.id }) : format(t("saveFailed"), { message: result.message ?? "" }));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: library_module_css_default.recipe,
				"data-testid": "library-recipe",
				"data-recipe": recipe.recipeId,
				"data-activation": recipe.activation.state,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: library_module_css_default.recipeHead,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: library_module_css_default.recipeName,
								children: recipe.displayName
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `${library_module_css_default.badge} ${recipe.healthy ? library_module_css_default.badgeOk : ""}`,
								children: recipe.healthy ? t("alreadyRunning") : residencyLabel(t, recipe.active ? "loading" : "cold")
							}),
							recipe.memoryGiB ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: library_module_css_default.muted,
								children: [recipe.memoryGiB, " GiB"]
							}) : null,
							recipe.typicalLoadSeconds ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: library_module_css_default.muted,
								children: ["~", duration(recipe.typicalLoadSeconds)]
							}) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
						className: library_module_css_default.tasks,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", {
							className: library_module_css_default.label,
							children: t("chooseTasks")
						}), recipe.tasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: `${library_module_css_default.task} ${task.bindable ? "" : library_module_css_default.taskOff}`,
							title: task.bindable ? task.feature : format(t("taskUnavailable"), { reason: reasonLabel(t, task.reason) }),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									disabled: !task.bindable,
									checked: task.bindable && selected.includes(task.id),
									onChange: (event) => {
										setChosen(event.target.checked ? [...selected, task.id] : selected.filter((id) => id !== task.id));
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: task.id }),
								!task.bindable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: library_module_css_default.muted,
									children: reasonLabel(t, task.reason)
								}) : null,
								task.bindable && !taskHasPass(row, task.id) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: library_module_css_default.taskNote,
									"data-testid": "library-task-declared",
									"data-task": task.id,
									children: t("taskDeclaredOnly")
								}) : null,
								recipe.endpointNotes?.[task.id] ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: library_module_css_default.taskNote,
									"data-testid": "library-endpoint-note",
									children: recipe.endpointNotes[task.id]
								}) : null
							]
						}, task.id))]
					}),
					recipe.notes ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: library_module_css_default.ownerNote,
						"data-testid": "library-recipe-notes",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [t("ownerNotes"), ":"] }),
							" ",
							recipe.notes
						]
					}) : null,
					speedAdvisories(row, recipe.recipeId).some((a) => a.recipeId === recipe.recipeId) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SpeedLine, {
						t,
						row: {
							...row,
							advisories: (row.advisories ?? []).filter((a) => a.recipeId === recipe.recipeId)
						},
						recipeId: recipe.recipeId
					}) : null,
					recipe.busy && recipe.busy.total > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.muted,
						"data-testid": "library-recipe-busy",
						children: format(t("busyRunning"), { count: recipe.busy.total })
					}) : null,
					recipe.planError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.bad,
						children: format(t("errorLine"), {
							code: recipe.planError.code,
							message: recipe.planError.message
						})
					}) : null,
					adapterLegacy && recipe.tasks.some((task) => task.reason === "ADAPTER_MODE_UNSUPPORTED") ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.muted,
						children: t("adapterLegacy")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: library_module_css_default.actions,
						children: [
							controllerMode !== "none" && !recipe.healthy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: library_module_css_default.primary,
								title: t("activateHint"),
								disabled: jobRunning || selected.length === 0 || snapshot.busy[`activate:${recipe.serverId}`] === true,
								onClick: () => {
									activate();
								},
								"data-testid": "library-activate",
								children: snapshot.busy[`activate:${recipe.serverId}`] ? t("activating") : t("activate")
							}) : null,
							controllerMode !== "none" && recipe.healthy && !recipe.usable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: library_module_css_default.primary,
								disabled: jobRunning || selected.length === 0,
								onClick: () => {
									face.store.bind({
										serverId: recipe.serverId,
										rowId: row.id,
										recipeId: recipe.recipeId,
										tasks: selected
									});
								},
								"data-testid": "library-bind",
								children: t("activate")
							}) : null,
							controllerMode !== "none" && recipe.active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: library_module_css_default.ghost,
								disabled: jobRunning,
								onClick: () => {
									face.store.deactivate(recipe.serverId, recipe.recipeId);
								},
								"data-testid": "library-deactivate",
								children: t("deactivate")
							}) : null,
							controllerMode === "none" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: library_module_css_default.muted,
								children: t("controllerNone")
							}) : null,
							busyError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: library_module_css_default.ghost,
								onClick: () => {
									activate(true);
								},
								children: t("confirmCancelRunning")
							}) : null
						]
					}),
					recipe.models.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: library_module_css_default.models,
						"aria-label": t("models"),
						children: recipe.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: library_module_css_default.model,
							"data-testid": "library-model",
							"data-model": model.id,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									className: library_module_css_default.code,
									children: model.id
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.tasks.join(", ") }),
								model.inputSampleRate && model.outputSampleRate ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: library_module_css_default.muted,
									children: format(t("sampleRates"), {
										input: model.inputSampleRate,
										output: model.outputSampleRate
									})
								}) : null,
								model.referenceAudio === "missing" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: library_module_css_default.bad,
									children: t("referenceMissing")
								}) : null,
								typeof model.requestOptionCount === "number" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: library_module_css_default.muted,
									"data-testid": "library-request-options",
									"data-statuses": JSON.stringify(model.requestOptionStatuses ?? null),
									children: [format(t("requestOptionsDeclared"), { count: model.requestOptionCount }), model.requestOptionStatuses ? ` · ${format(t("requestOptionStatuses"), { statuses: Object.entries(model.requestOptionStatuses).map(([k, n]) => `${k} ${n}`).join(", ") })}` : ""]
								}) : null,
								model.liveOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: library_module_css_default.muted,
									"data-testid": "library-live-only",
									children: t("liveOnly")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: library_module_css_default.secondary,
									disabled: !recipe.usable,
									title: format(t("useHint"), { model: model.name ?? model.id }),
									onClick: () => {
										use(model);
									},
									"data-testid": "library-use",
									children: t("useHere")
								})
							]
						}, model.id))
					}) : null,
					useStatus !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.muted,
						role: "status",
						children: useStatus
					}) : null
				]
			});
		}
		function RowDetails({ t, face, row, doc, snapshot, onClose }) {
			const adapterLegacy = doc.adapter.binding === "settings";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
				className: library_module_css_default.detail,
				"data-testid": "library-detail",
				"data-row": row.id,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: library_module_css_default.detailHead,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							className: library_module_css_default.detailTitle,
							children: row.displayName
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: library_module_css_default.ghost,
							onClick: onClose,
							children: t("close")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
						className: library_module_css_default.facts,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("repository") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
								className: library_module_css_default.code,
								children: unknownish(t, row.repo)
							}) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("revision") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
								className: library_module_css_default.code,
								children: unknownish(t, row.revision)
							}) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("architecture") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [
								row.engine ?? t("notInCatalog"),
								" · ",
								unknownish(t, row.architecture)
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("access") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [unknownish(t, row.access), row.accessPrerequisite ? ` — ${row.accessPrerequisite}` : ""] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("license") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: unknownish(t, row.license) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("colStatus") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [
								row.lifecycle,
								row.lifecycleReason ? ` — ${row.lifecycleReason}` : "",
								row.blockedPrerequisite ? ` — ${t("prerequisite")}: ${row.blockedPrerequisite}` : ""
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("colDownload") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [row.download.state, row.download.localBytes !== null ? ` · ${bytes(row.download.localBytes)}${row.download.expectedBytes !== null ? ` / ${bytes(row.download.expectedBytes)}` : ""}` : ""] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("colEvidence") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [
								t("backend"),
								" ",
								evidenceLabel(t, row.acceptance.backend.state),
								" · ",
								t("desktop"),
								" ",
								evidenceLabel(t, row.acceptance.desktop.state),
								row.acceptance.missingModes.length > 0 ? ` · ${row.acceptance.missingModes.join(", ")}` : ""
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("hardware") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [unknownish(t, row.hardware.feasibility), row.hardware.estimatedWeightGiB !== null ? ` · ${row.hardware.estimatedWeightGiB} GiB` : ""] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("modalities") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [
								row.modalities.input.join(", ") || t("notInCatalog"),
								" → ",
								row.modalities.output.join(", ") || t("notInCatalog")
							] }),
							row.testedImage ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("testedImage") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
								className: library_module_css_default.code,
								children: row.testedImage
							}) })] }) : null,
							row.weightIdentity ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("resultScope") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", {
								"data-testid": "library-result-scope",
								children: [format(t("weightsLine"), {
									precision: row.weightIdentity.precision ?? t("unknown"),
									method: row.weightIdentity.quantizationMethod ?? t("unknown"),
									base: row.weightIdentity.baseCheckpoint ?? t("unknown"),
									relation: row.weightIdentity.publisherRelation ?? t("unknown")
								}), row.weightIdentity.resultScope ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: library_module_css_default.taskNote,
									children: row.weightIdentity.resultScope
								}) : null]
							})] }) : null,
							row.dependencyCompleteness && !row.dependencyCompleteness.complete ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("dependencies") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
								className: library_module_css_default.bad,
								children: format(t("dependencyOpen"), { count: row.dependencyCompleteness.open })
							})] }) : null
						]
					}),
					(row.runtimeDefects ?? []).length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: library_module_css_default.error,
						"data-testid": "library-runtime-defects",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("runtimeDefects") }), (row.runtimeDefects ?? []).map((d) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
							d.summary,
							d.upstreamIssue?.url ? ` — ${d.upstreamIssue.url} (${d.upstreamIssue.state ?? t("unknown")})` : "",
							d.upstreamFix?.url ? ` — ${d.upstreamFix.url} (${d.upstreamFix.state ?? t("unknown")})` : ""
						] }, d.id ?? d.summary ?? ""))]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(EvidenceDetails, {
						t,
						row
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: library_module_css_default.h3,
						children: t("runtimes")
					}),
					row.recipes.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.muted,
						children: t("noRecipes")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: library_module_css_default.recipes,
						children: row.recipes.map((recipe) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RecipeCard, {
							t,
							face,
							row,
							recipe,
							server: doc.servers.find((s) => s.id === recipe.serverId),
							snapshot,
							adapterLegacy
						}, `${recipe.serverId}/${recipe.recipeId}`))
					}),
					row.staticRoutes.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.muted,
						children: row.staticRoutes.map((r) => `${r.provider}/${r.model} (${r.mode})`).join(" · ")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: library_module_css_default.h3,
						children: t("streamingModes")
					}),
					row.streamingModes.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.muted,
						children: t("notInCatalog")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: library_module_css_default.scroll,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
							className: library_module_css_default.table,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: row.streamingModes.map((mode) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									className: library_module_css_default.code,
									children: mode.mode
								}) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [
									t("runtimeSupport"),
									": ",
									unknownish(t, mode.runtimeSupport)
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [
									t("backend"),
									": ",
									evidenceLabel(t, mode.backend.state)
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [
									t("desktop"),
									": ",
									evidenceLabel(t, mode.desktop.state)
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									className: library_module_css_default.muted,
									children: [mode.backend.notes, mode.desktop.notes].filter(Boolean).join(" · ")
								})
							] }, mode.mode)) })
						})
					}),
					row.endpoints.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: library_module_css_default.h3,
						children: t("endpoints")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: library_module_css_default.plain,
						children: row.endpoints.map((e, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", {
								className: library_module_css_default.code,
								children: [
									e.task ?? "?",
									" ",
									e.path ?? "",
									" ",
									e.protocol
								]
							}),
							" ",
							e.inputSampleRate ?? "",
							e.outputSampleRate ? ` → ${e.outputSampleRate}` : ""
						] }, i))
					})] }) : null,
					row.dependencies.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: library_module_css_default.h3,
						children: t("dependencies")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: library_module_css_default.plain,
						children: row.dependencies.map((d, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
							d.role ?? "?",
							" · ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
								className: library_module_css_default.code,
								children: d.asset ?? "?"
							}),
							d.required ? " *" : "",
							" · ",
							d.downloadState ?? t("unknown")
						] }, i))
					})] }) : null,
					row.sources.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: library_module_css_default.h3,
						children: t("sources")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: library_module_css_default.plain,
						children: row.sources.map((s, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", {
							className: library_module_css_default.code,
							children: [
								s.kind,
								": ",
								s.ref
							]
						}) }, i))
					})] }) : null,
					row.notes ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: library_module_css_default.h3,
						children: t("notes")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.muted,
						children: row.notes
					})] }) : null
				]
			});
		}
		function countsText(counts, total) {
			const parts = Object.entries(counts ?? {}).map(([state, n]) => `${state} ${n}`);
			return `${total ?? "?"}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
		}
		function speedAdvisories(row, recipeId) {
			return (row.advisories ?? []).filter((a) => (a.kind === "below-realtime" || a.kind === "speed-metric") && (recipeId === void 0 || a.recipeId === recipeId || a.scope !== "recipe"));
		}
		function metricText(t, m) {
			const value = m.range ? `${m.range[0]}–${m.range[1]}` : String(m.value);
			const cls = {
				"below-realtime": "speedClass_below",
				"at-or-above-realtime": "speedClass_above",
				mixed: "speedClass_mixed",
				unclassified: "speedClass_unclassified",
				latency: "speedClass_latency"
			}[m.classification];
			return [
				format(t("speedMetricLine"), {
					metric: m.metric,
					value,
					unit: m.unit ?? "?",
					formula: m.formula ?? "?"
				}),
				t(cls),
				format(t("speedKind"), { kind: m.measurementKind }),
				[
					m.statistic,
					m.n !== null ? `n=${m.n}` : null,
					m.phase,
					m.hardware
				].filter(Boolean).join(" · "),
				m.conditions ?? "",
				m.rawLabel || m.rawValue ? format(t("speedRaw"), {
					label: m.rawLabel ?? "",
					value: m.rawValue ?? ""
				}) : ""
			].filter((p) => p !== "").join(" · ");
		}
		function SpeedLine({ t, row, recipeId }) {
			const speed = speedAdvisories(row, recipeId);
			if (speed.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: library_module_css_default.muted,
				"data-testid": "library-speed-none",
				children: [
					t("speed"),
					": ",
					t("speedNone")
				]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: library_module_css_default.plain,
				"data-testid": "library-speed",
				children: speed.map((a, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
					className: a.kind === "below-realtime" ? library_module_css_default.warn : library_module_css_default.muted,
					"data-kind": a.kind,
					"data-classification": a.metric?.classification ?? (a.kind === "below-realtime" ? "below-realtime" : ""),
					"data-derived": a.derived,
					children: [
						a.kind === "below-realtime" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
							t("speed"),
							": ",
							t("speedBelowRealtime")
						] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("speed") }),
						" · ",
						a.metric ? metricText(t, a.metric) : format(t("speedBasisNote"), { source: t(a.source === "recipe" ? "sourceRecipe" : "sourceCatalog") }),
						a.mode ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
							className: library_module_css_default.code,
							children: a.mode
						})] }) : null,
						a.task ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
							className: library_module_css_default.code,
							children: a.task
						})] }) : null,
						a.layer ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", t(a.layer === "desktop" ? "desktop" : "backend")] }) : null,
						a.text && !a.metric ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: library_module_css_default.muted,
							children: [" — ", a.text]
						}) : null
					]
				}, i))
			});
		}
		function EvidenceDetails({ t, row }) {
			const tasks = [...new Set([...row.tasks.map((x) => x.id), ...Object.keys(row.taskAcceptance ?? {})])];
			const summary = row.acceptanceSummary;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"data-testid": "library-evidence-details",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: library_module_css_default.h3,
						children: t("evidenceDetails")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.muted,
						children: t("functionVsSpeed")
					}),
					row.acceptance.backend.notes ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: row.acceptance.backend.state === "fail" ? library_module_css_default.bad : library_module_css_default.muted,
						"data-testid": "library-row-backend-notes",
						children: [
							t("backend"),
							" ",
							evidenceLabel(t, row.acceptance.backend.state),
							": ",
							row.acceptance.backend.notes
						]
					}) : null,
					summary ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.muted,
						"data-testid": "library-acceptance-summary",
						children: format(t("summaryLine"), {
							tasks: countsText(summary.tasksBackend, summary.tasksTotal),
							modes: countsText(summary.modesBackend, summary.modesTotal),
							complete: t(summary.rowComplete ? "yes" : "no")
						})
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SpeedLine, {
						t,
						row
					}),
					(row.performanceProvenance ?? []).length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						"data-testid": "library-rate-corrections",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
							className: library_module_css_default.muted,
							children: [
								t("rateCorrections"),
								" (",
								(row.performanceProvenance ?? []).length,
								")"
							]
						}), (row.performanceProvenance ?? []).map((p, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: library_module_css_default.muted,
							children: format(t("rateCorrectionLine"), {
								metric: p.metric ?? t("unknown"),
								scope: p.scope ?? "",
								key: p.key ?? "",
								layer: p.layer ?? "",
								value: Array.isArray(p.ownerValue) ? p.ownerValue.join("–") : String(p.ownerValue ?? t("unknown")),
								note: p.note ?? "",
								rawPolicy: p.rawPolicy ?? t("unknown"),
								items: p.items,
								sha: (p.correctionSha256 ?? "").slice(0, 12)
							})
						}, index))]
					}) : null,
					tasks.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: library_module_css_default.scroll,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
							className: library_module_css_default.table,
							"data-testid": "library-task-evidence",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("colTask") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("backend") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("desktop") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("colNotes") })
							] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: tasks.map((task) => {
								const ev = row.taskAcceptance?.[task];
								const notes = [ev?.backend.notes, ev?.desktop.notes].filter(Boolean).join(" · ");
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
									"data-task": task,
									"data-backend": ev?.backend.state ?? "unverified",
									"data-desktop": ev?.desktop.state ?? "unverified",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
											className: library_module_css_default.code,
											children: task
										}) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: ev?.backend.state === "fail" ? library_module_css_default.bad : "",
											children: evidenceLabel(t, ev?.backend.state ?? "unverified")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: ev?.desktop.state === "fail" ? library_module_css_default.bad : "",
											children: evidenceLabel(t, ev?.desktop.state ?? "unverified")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: library_module_css_default.muted,
											children: notes
										})
									]
								}, task);
							}) })]
						})
					}) : null
				]
			});
		}
		const uniq = (values) => [...new Set(values.filter((v) => typeof v === "string" && v !== ""))].sort();
		function LibraryView(props) {
			const t = (key, values) => format(props.t(key), values);
			const face = props.libraryView;
			const snapshot = (0, react.useSyncExternalStore)(face.store.subscribe, face.store.getSnapshot);
			const nav = (0, react.useSyncExternalStore)(face.nav.subscribe, face.nav.getSnapshot);
			const [query, setQuery] = (0, react.useState)("");
			const [filters, setFilters] = (0, react.useState)({
				role: "",
				task: "",
				lifecycle: "",
				download: "",
				residency: "",
				engine: "",
				streaming: "",
				evidence: ""
			});
			const [showAssets, setShowAssets] = (0, react.useState)(false);
			const doc = snapshot.doc;
			const rows = doc?.rows ?? [];
			const options = (0, react.useMemo)(() => ({
				role: uniq(rows.filter((r) => showAssets || r.selectable).map((r) => r.role)),
				task: uniq(rows.flatMap((r) => r.tasks.map((x) => x.id))),
				lifecycle: uniq(rows.map((r) => r.lifecycle)),
				download: uniq(rows.map((r) => r.download.state)),
				residency: uniq(rows.map((r) => r.residency)),
				engine: uniq(rows.map((r) => r.engine)),
				streaming: uniq(rows.flatMap((r) => r.streamingModes.map((m) => m.mode))),
				evidence: [
					"backend-pass",
					"desktop-pass",
					"unverified"
				]
			}), [rows, showAssets]);
			const visible = rows.filter((row) => {
				if (!showAssets && !row.selectable) return false;
				if (filters.role && row.role !== filters.role) return false;
				if (filters.task && !row.tasks.some((x) => x.id === filters.task)) return false;
				if (filters.lifecycle && row.lifecycle !== filters.lifecycle) return false;
				if (filters.download && row.download.state !== filters.download) return false;
				if (filters.residency && row.residency !== filters.residency) return false;
				if (filters.engine && row.engine !== filters.engine) return false;
				if (filters.streaming && !row.streamingModes.some((m) => m.mode === filters.streaming)) return false;
				if (filters.evidence === "backend-pass" && row.acceptance.backend.state !== "pass") return false;
				if (filters.evidence === "desktop-pass" && row.acceptance.desktop.state !== "pass") return false;
				if (filters.evidence === "unverified" && (row.acceptance.backend.state === "pass" || row.acceptance.desktop.state === "pass")) return false;
				const q = query.trim().toLowerCase();
				if (q !== "") {
					const hay = [
						row.id,
						row.displayName,
						row.family,
						row.repo,
						row.architecture,
						...row.tasks.map((x) => x.id)
					].join(" ").toLowerCase();
					if (!q.split(/\s+/u).every((part) => hay.includes(part))) return false;
				}
				return true;
			});
			const selected = rows.find((r) => r.id === nav.rowId);
			const target = nav.sessionId === void 0 ? void 0 : face.sessionTitle(nav.sessionId) ?? nav.sessionId;
			if (snapshot.status === "absent") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: library_module_css_default.page,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: library_module_css_default.muted,
					children: t("notInstalled")
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: library_module_css_default.page,
				"data-testid": "model-library-view",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: library_module_css_default.header,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
								className: library_module_css_default.title,
								children: t("title")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: library_module_css_default.muted,
								children: t("subtitle")
							}),
							target !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: library_module_css_default.target,
								"data-testid": "library-target",
								children: ["→ ", target]
							}) : null
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: library_module_css_default.primary,
							title: t("refreshHint"),
							disabled: doc?.configured !== true || snapshot.busy["refresh:*"] === true,
							onClick: () => {
								face.store.refresh();
							},
							"data-testid": "library-refresh",
							children: snapshot.busy["refresh:*"] ? t("refreshing") : t("refresh")
						})]
					}),
					snapshot.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.muted,
						children: t("loading")
					}) : null,
					snapshot.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.bad,
						children: format(t("loadFailed"), { message: snapshot.message ?? "" })
					}) : null,
					doc !== null && !doc.configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.empty,
						"data-testid": "library-no-server",
						children: t("noServer")
					}) : null,
					doc !== null && !doc.adapter.present ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: library_module_css_default.bad,
						children: t("adapterMissing")
					}) : null,
					snapshot.lastError ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: library_module_css_default.error,
						role: "alert",
						"data-testid": "library-error",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: format(t("errorLine"), {
							code: String(snapshot.lastError.extra?.controllerCode ?? snapshot.lastError.code),
							message: snapshot.lastError.message
						}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: library_module_css_default.ghost,
							onClick: () => {
								face.store.clearError();
							},
							children: t("close")
						})]
					}) : null,
					(doc?.servers ?? []).map((server) => {
						const catalog = doc?.catalogs.find((c) => c.serverId === server.id);
						const controller = server.controller;
						const controllerText = controller.mode === "none" ? t("controllerNone") : controller.state === "reachable" ? t("controllerReachable") : controller.state === "unreachable" ? format(t("controllerUnreachable"), { message: controller.error?.message ?? "" }) : controller.state === "checking" ? t("controllerChecking") : t("controllerUnknown");
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: library_module_css_default.server,
							"data-testid": "library-server",
							"data-controller": controller.state,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: library_module_css_default.serverHead,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: server.displayName }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: controller.state === "unreachable" ? library_module_css_default.bad : library_module_css_default.muted,
											children: controllerText
										}),
										catalog?.source ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: library_module_css_default.muted,
											children: format(t("catalogLine"), {
												version: catalog.catalogVersion ?? "?",
												completeness: catalog.completeness ?? "?",
												count: catalog.rowCount
											})
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: library_module_css_default.muted,
											children: t("catalogMissing")
										})
									]
								}),
								catalog?.completeness && catalog.completeness !== "full_census" && catalog.completeness !== "refreshed_for_acceptance" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: library_module_css_default.muted,
									children: t("catalogIncomplete")
								}) : null,
								server.switching && !server.switching.allowed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: library_module_css_default.bad,
									children: format(t("switchingBlocked"), { reason: server.switching.reason ?? server.switching.code ?? "" })
								}) : null,
								server.foreignWorkloads.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: library_module_css_default.bad,
									children: format(t("foreign"), { names: server.foreignWorkloads.join(", ") })
								}) : null,
								server.bindingError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: library_module_css_default.bad,
									children: format(t("errorLine"), {
										code: server.bindingError.code,
										message: server.bindingError.message
									})
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(JobBanner, {
									t,
									server,
									store: face.store,
									snapshot
								})
							]
						}, server.id);
					}),
					rows.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: library_module_css_default.filters,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: library_module_css_default.search,
								type: "search",
								placeholder: t("search"),
								"aria-label": t("search"),
								value: query,
								onChange: (event) => {
									setQuery(event.target.value);
								},
								"data-testid": "library-search"
							}),
							Object.keys(filters).map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: library_module_css_default.filter,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: library_module_css_default.label,
									children: t(`filter${key[0].toUpperCase()}${key.slice(1)}`)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									className: library_module_css_default.select,
									value: filters[key],
									onChange: (event) => {
										setFilters({
											...filters,
											[key]: event.target.value
										});
									},
									"data-testid": `library-filter-${key}`,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: t("any")
									}), options[key].map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value,
										children: key === "residency" ? residencyLabel(t, value) : value
									}, value))]
								})]
							}, key)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: library_module_css_default.check,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: showAssets,
									onChange: (event) => {
										setShowAssets(event.target.checked);
									}
								}), t("showAssets")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: library_module_css_default.muted,
								"data-testid": "library-count",
								children: format(t("results"), {
									count: visible.length,
									total: rows.filter((r) => showAssets || r.selectable).length
								})
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: library_module_css_default.body,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
								className: library_module_css_default.list,
								"data-testid": "library-list",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("colModel") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("colTasks") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("colStatus") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("colDownload") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("colServer") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("colEvidence") })
								] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: visible.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
									className: row.id === nav.rowId ? library_module_css_default.rowOn : library_module_css_default.row,
									"data-testid": "library-row",
									"data-row": row.id,
									"data-residency": row.residency,
									tabIndex: 0,
									onClick: () => {
										face.nav.set({ rowId: row.id });
									},
									onKeyDown: (event) => {
										if (event.key === "Enter") face.nav.set({ rowId: row.id });
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: library_module_css_default.rowName,
												children: row.displayName
											}),
											row.role === "secondary_av" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: library_module_css_default.badge,
												"data-testid": "library-role-av",
												children: t("roleAv")
											})] }) : null,
											row.role === "auxiliary_asset" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: library_module_css_default.badge,
												"data-testid": "library-role-asset",
												children: t("roleAsset")
											})] }) : null,
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
												className: library_module_css_default.code,
												children: row.id
											})
										] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: library_module_css_default.chips,
											children: row.tasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: `${library_module_css_default.chip} ${task.bindable ? library_module_css_default.chipOn : ""}`,
												title: task.bindable ? "" : reasonLabel(t, task.reason),
												children: task.id
											}, task.id))
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [row.lifecycle, row.blockedPrerequisite ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${library_module_css_default.muted} ${library_module_css_default.clamp}`,
											title: row.blockedPrerequisite,
											children: row.blockedPrerequisite
										})] }) : row.lifecycleReason ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${library_module_css_default.muted} ${library_module_css_default.clamp}`,
											title: row.lifecycleReason,
											children: row.lifecycleReason
										})] }) : null] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [row.download.state, row.download.localBytes ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: library_module_css_default.muted,
											children: bytes(row.download.localBytes)
										})] }) : null] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${library_module_css_default.badge} ${row.residency === "active" ? library_module_css_default.badgeOk : ""}`,
											children: residencyLabel(t, row.residency)
										}) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
											className: library_module_css_default.muted,
											children: [
												t("backend"),
												" ",
												evidenceLabel(t, row.acceptance.backend.state),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}),
												t("desktop"),
												" ",
												evidenceLabel(t, row.acceptance.desktop.state),
												(row.advisories ?? []).some((a) => a.kind === "below-realtime") ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: library_module_css_default.warnBadge,
													"data-testid": "library-badge-below-realtime",
													children: t("badgeBelowRealtime")
												})] }) : null,
												(row.advisories ?? []).some((a) => a.kind === "owner-note") ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: library_module_css_default.badge,
													"data-testid": "library-badge-owner-notes",
													children: t("badgeOwnerNotes")
												})] }) : null
											]
										})
									]
								}, row.id)) })]
							}),
							visible.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: library_module_css_default.muted,
								children: t("noMatch")
							}) : null,
							selected !== void 0 && doc !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RowDetails, {
								t,
								face,
								row: selected,
								doc,
								snapshot,
								onClose: () => {
									face.nav.set({ rowId: void 0 });
								}
							}) : null
						]
					})] }) : null
				]
			});
		}
		//#endregion
		//#region src/client/SettingsCard.tsx
		/**
		* Settings → Plugins card for `dsh-audio-model-library`: GPU servers and how to activate their models.
		* Stores host names, SSH aliases and environment-variable NAMES only — never keys, tokens or passwords.
		*/
		const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$|^\[[0-9A-Fa-f:.]+\]$/;
		const SSH_DEST = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,254}$/;
		const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;
		function slug(text) {
			const base = text.normalize("NFKD").toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-+|-+$/gu, "").slice(0, 32);
			return base === "" ? "gpu-server" : base;
		}
		const EMPTY = {
			name: "",
			modelHost: "",
			mode: "ssh",
			sshDestination: "",
			sshCommand: "dsh-audio-ctl",
			httpURL: "",
			tokenEnv: "",
			catalogFile: "",
			apiKeyEnv: ""
		};
		function SettingsCard(props) {
			const t = (key, values) => format(props.t(key), values);
			const face = props.librarySettings;
			const settings = (0, react.useSyncExternalStore)(face.scope.subscribe, face.scope.getSnapshot);
			const [open, setOpen] = (0, react.useState)(false);
			const [form, setForm] = (0, react.useState)(EMPTY);
			const [invalid, setInvalid] = (0, react.useState)([]);
			const [status, setStatus] = (0, react.useState)("");
			const [saving, setSaving] = (0, react.useState)(false);
			if (settings.status === "unavailable") return null;
			const servers = Array.isArray(settings.value?.servers) ? settings.value.servers : [];
			const writable = settings.writable;
			const write = async (next) => {
				setSaving(true);
				setStatus(t("saving"));
				try {
					await face.scope.mutate([{
						op: "set",
						path: ["servers"],
						value: next
					}]);
					const after = face.scope.getSnapshot().value?.servers ?? [];
					if (JSON.stringify(after.map((s) => s.id)) !== JSON.stringify(next.map((s) => s.id))) throw new Error("the host refused the update");
					setStatus(t("saved"));
					face.store.load();
					return true;
				} catch (error) {
					setStatus(t("saveFailed", { message: error instanceof Error ? error.message : String(error) }));
					return false;
				} finally {
					setSaving(false);
				}
			};
			const add = async () => {
				const problems = [];
				if (form.name.trim() === "") problems.push("name");
				if (!HOST.test(form.modelHost.trim())) problems.push("modelHost");
				if (form.mode === "ssh" && !SSH_DEST.test(form.sshDestination.trim())) problems.push("sshDestination");
				if (form.mode === "http" && !/^https?:\/\/[^\s/@]+/u.test(form.httpURL.trim())) problems.push("httpURL");
				if (form.mode === "http" && !ENV.test(form.tokenEnv.trim())) problems.push("tokenEnv");
				if (form.catalogFile.trim() !== "" && !form.catalogFile.trim().startsWith("/")) problems.push("catalogFile");
				if (form.apiKeyEnv.trim() !== "" && !ENV.test(form.apiKeyEnv.trim())) problems.push("apiKeyEnv");
				setInvalid(problems);
				if (problems.length > 0) {
					setStatus(t("invalid"));
					return;
				}
				const taken = new Set(servers.map((s) => s.id));
				let id = slug(form.name);
				for (let n = 2; taken.has(id); n++) id = `${slug(form.name)}-${n}`;
				const controller = form.mode === "ssh" ? {
					mode: "ssh",
					sshDestination: form.sshDestination.trim(),
					sshCommand: form.sshCommand.trim() || "dsh-audio-ctl"
				} : form.mode === "http" ? {
					mode: "http",
					httpURL: form.httpURL.trim(),
					tokenEnv: form.tokenEnv.trim()
				} : { mode: "none" };
				const server = {
					id,
					displayName: form.name.trim(),
					modelHost: form.modelHost.trim(),
					controller,
					...form.catalogFile.trim() !== "" ? { catalogFile: form.catalogFile.trim() } : {},
					...form.apiKeyEnv.trim() !== "" ? { apiKeyEnv: form.apiKeyEnv.trim() } : {}
				};
				if (await write([...servers, server])) setForm(EMPTY);
			};
			const field = (key, label, hint, placeholder) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: library_module_css_default.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: library_module_css_default.label,
						children: t(label)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: `${library_module_css_default.input} ${invalid.includes(key) ? library_module_css_default.inputBad : ""}`,
						value: form[key],
						placeholder,
						disabled: !writable,
						"aria-invalid": invalid.includes(key),
						onChange: (event) => {
							setForm({
								...form,
								[key]: event.target.value
							});
						},
						"data-testid": `library-field-${key}`
					}),
					hint ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: library_module_css_default.hint,
						children: t(hint)
					}) : null
				]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: `${library_module_css_default.card} ${open ? library_module_css_default.cardOpen : ""}`,
				"data-testid": "library-settings-card",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: library_module_css_default.cardHeader,
					"aria-expanded": open,
					onClick: () => {
						setOpen(!open);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: library_module_css_default.cardText,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: library_module_css_default.cardName,
							children: t("cardTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: library_module_css_default.muted,
							children: t("cardDescription")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: library_module_css_default.count,
						children: servers.length
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: library_module_css_default.cardBody,
					children: [
						!writable && settings.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: library_module_css_default.muted,
							children: t("readOnly")
						}) : null,
						servers.length === 0 && settings.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: library_module_css_default.muted,
							children: t("cardEmpty")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: library_module_css_default.plain,
							children: servers.map((server) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								className: library_module_css_default.serverRow,
								"data-testid": "library-settings-server",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: server.displayName }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										className: library_module_css_default.code,
										children: server.modelHost ?? "—"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: library_module_css_default.muted,
										children: server.controller?.mode === "ssh" ? `ssh ${server.controller.sshDestination ?? ""} ${server.controller.sshCommand ?? ""}` : server.controller?.mode === "http" ? server.controller.httpURL : t("modeNone")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: library_module_css_default.secondary,
										onClick: () => {
											face.store.refresh(server.id).then(() => {
												face.openLibrary();
											});
										},
										"data-testid": "library-settings-check",
										children: t("check")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: library_module_css_default.ghost,
										disabled: !writable || saving,
										onClick: () => {
											write(servers.filter((s) => s.id !== server.id));
										},
										children: t("remove")
									})
								]
							}, server.id))
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
							className: library_module_css_default.form,
							onSubmit: (event) => {
								event.preventDefault();
								add();
							},
							"data-testid": "library-settings-form",
							children: [
								field("name", "fieldName"),
								field("modelHost", "fieldModelHost", "fieldModelHostHint", "192.168.1.20"),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: library_module_css_default.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: library_module_css_default.label,
										children: t("fieldMode")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										className: library_module_css_default.input,
										value: form.mode,
										disabled: !writable,
										onChange: (event) => {
											setForm({
												...form,
												mode: event.target.value
											});
										},
										"data-testid": "library-field-mode",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "ssh",
												children: t("modeSsh")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "http",
												children: t("modeHttp")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "none",
												children: t("modeNone")
											})
										]
									})]
								}),
								form.mode === "ssh" ? field("sshDestination", "fieldSshDestination", "fieldSshDestinationHint", "gpu-server") : null,
								form.mode === "ssh" ? field("sshCommand", "fieldSshCommand") : null,
								form.mode === "http" ? field("httpURL", "fieldHttpUrl", void 0, "http://10.0.0.5:18190") : null,
								form.mode === "http" ? field("tokenEnv", "fieldTokenEnv", "fieldTokenEnvHint", "AUDIO_CONTROLLER_TOKEN") : null,
								field("catalogFile", "fieldCatalogFile", "fieldCatalogFileHint"),
								field("apiKeyEnv", "fieldApiKeyEnv", "fieldTokenEnvHint"),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: library_module_css_default.actions,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										role: "status",
										className: library_module_css_default.muted,
										"data-testid": "library-settings-status",
										children: status
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "submit",
										className: library_module_css_default.primary,
										disabled: !writable || saving,
										children: saving ? t("saving") : t("add")
									})]
								})
							]
						})
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/SidebarIcon.tsx
		/** Sidebar panel-list icon for the audio model library (waveform over a stack). */
		function SidebarIcon(props) {
			const size = props.size ?? 16;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				"data-testid": "library-sidebar-icon",
				"data-active": props.active === true,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M2 9.5V6.5M4.5 11V5M7 12.5V3.5M9.5 10V6M12 11.5V4.5M14 9V7",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round"
				})
			});
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser half of dsh-audio-model-library (shared by Web and Desktop):
		* - `main` view `model-library` + `sidebar.panellist` entry: the full audio model catalog with search,
		*   filters, evidence, task selection, controlled activation progress/errors and "use in this conversation";
		* - `conversation.input.left` chip: the session's library model state, opening the library for that session;
		* - `settings.plugin.item` card keyed `dsh-audio-model-library`: GPU servers and activation access;
		* - client service `audioModelLibrary` (status/document/open) for other plugins (dsh-voice-capture).
		* Recording, playback, Live and task inputs stay in dsh-voice-capture; wire protocols stay in dsh-dgx-audio.
		*/
		const PANEL_ID = "model-library";
		const SETTINGS_NS = "dsh-audio-model-library";
		const inject = [
			"slots",
			"locale",
			"settingsScope",
			"sessions",
			"remote",
			"remote.session",
			"layout"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				en,
				zh
			}), "audio-model-library: dictionaries");
			const store = new LibraryStore();
			const nav = new NavStore();
			ctx.effect(() => () => {
				store.dispose();
			}, "audio-model-library: store");
			store.load();
			ctx.effect(() => ctx.remote.$on("settings/document-updated", () => {
				store.load();
			}), "audio-model-library: settings refresh");
			ctx.effect(() => ctx.remote.$on("llm/adapters-updated", () => {
				store.load();
			}), "audio-model-library: adapter refresh");
			ctx.effect(() => ctx.on("connection/reset", () => {
				store.load();
			}), "audio-model-library: reconnect refresh");
			const open = (options = {}) => {
				nav.set({
					...options.sessionId !== void 0 ? { sessionId: options.sessionId } : {},
					...options.rowId !== void 0 ? { rowId: options.rowId } : {}
				});
				ctx.layout.selectPanel(PANEL_ID);
			};
			ctx.effect(() => ctx.reflect.provide("audioModelLibrary", createFace(store, open)), "audio-model-library: client service");
			const viewFace = {
				store,
				nav,
				async selectModel(sessionId, provider, model) {
					try {
						const result = await ctx.remote.session.selectModel({
							sessionId,
							provider,
							model
						});
						if (result?.ok === false) return {
							ok: false,
							message: result.error?.message ?? result.error?.code ?? "failed"
						};
						return { ok: true };
					} catch (error) {
						return {
							ok: false,
							message: error instanceof Error ? error.message : String(error)
						};
					}
				},
				sessionTitle(sessionId) {
					const summary = ctx.sessions.list.getSnapshot().byId?.[sessionId];
					return typeof summary?.title === "string" && summary.title !== "" ? summary.title : void 0;
				}
			};
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => ({ libraryView: viewFace })
			}, LibraryView));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 60,
				label: () => ctx.locale.bind(NS)("navLabel")
			}, SidebarIcon));
			const chipFace = {
				store,
				open
			};
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "dsh-audio-model-library-chip",
				order: 95,
				locale: NS,
				inject: () => ({ libraryChip: chipFace })
			}, LibraryChip));
			const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
			const settingsFace = {
				scope: {
					getSnapshot: () => scope.getSnapshot(),
					subscribe: (listener) => scope.subscribe(listener),
					mutate: (ops) => scope.mutate(ops)
				},
				store,
				openLibrary: () => {
					ctx.layout.selectPanel(PANEL_ID);
				}
			};
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: SETTINGS_NS,
				locale: NS,
				inject: () => ({ librarySettings: settingsFace })
			}, SettingsCard));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map