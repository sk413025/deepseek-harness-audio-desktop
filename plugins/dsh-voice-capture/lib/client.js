window.__ModuleLoader__.load({
	id: "dsh-voice-capture",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/capture.ts
		/** Error carrying a {@link CaptureFailure} category. */
		var CaptureError = class extends Error {
			/** Failure category. */
			failure;
			/**
			* @param failure - failure category.
			* @param message - underlying browser message.
			*/
			constructor(failure, message) {
				super(message);
				this.name = "CaptureError";
				this.failure = failure;
			}
		};
		const WORKLET_NAME = "dsh-voice-capture-tap";
		/** Worklet source: downmix every render quantum to mono and post it to the page. */
		const WORKLET_SOURCE = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input.length > 0 && input[0].length > 0) {
      const frames = input[0].length
      const mono = new Float32Array(frames)
      for (let c = 0; c < input.length; c++) {
        const channel = input[c]
        for (let i = 0; i < frames; i++) mono[i] += channel[i]
      }
      if (input.length > 1) for (let i = 0; i < frames; i++) mono[i] /= input.length
      this.port.postMessage(mono, [mono.buffer])
    }
    return true
  }
}
registerProcessor(${JSON.stringify(WORKLET_NAME)}, Tap)
`;
		/**
		* Map a getUserMedia rejection to a failure category.
		* @param error - rejection value.
		* @returns the categorized error.
		*/
		function classifyMediaError(error) {
			const name = error instanceof Error || typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
			const message = error instanceof Error ? error.message : String(error);
			switch (name) {
				case "NotAllowedError":
				case "SecurityError":
				case "PermissionDeniedError": return new CaptureError("permission-denied", message);
				case "NotFoundError":
				case "OverconstrainedError":
				case "DevicesNotFoundError": return new CaptureError("no-device", message);
				case "NotReadableError":
				case "AbortError":
				case "TrackStartError": return new CaptureError("device-busy", message);
				case "TypeError":
				case "NotSupportedError": return new CaptureError("unsupported", message);
				default: return new CaptureError("capture-failed", message);
			}
		}
		/**
		* Browser capture backend over `navigator.mediaDevices` and Web Audio.
		* @returns the backend bound to the current page globals.
		*/
		function browserCaptureBackend() {
			return {
				support() {
					if (typeof window === "undefined") return "unsupported";
					if (window.isSecureContext === false) return "insecure-context";
					if (navigator.mediaDevices?.getUserMedia === void 0) return "unsupported";
					if (typeof AudioContext !== "function") return "unsupported";
				},
				async listDevices() {
					if (navigator.mediaDevices?.enumerateDevices === void 0) return [];
					return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput").map((device) => ({
						id: device.deviceId === "default" ? "" : device.deviceId,
						label: device.label
					})).filter((device, index, all) => all.findIndex((other) => other.id === device.id) === index);
				},
				onDeviceChange(listener) {
					const media = navigator.mediaDevices;
					if (media?.addEventListener === void 0) return () => {};
					media.addEventListener("devicechange", listener);
					return () => {
						media.removeEventListener("devicechange", listener);
					};
				},
				async open({ deviceId, onFrames, onEnded, sampleRate }) {
					let context;
					try {
						context = sampleRate === void 0 ? new AudioContext() : new AudioContext({ sampleRate });
					} catch (error) {
						throw new CaptureError("unsupported", String(error));
					}
					const resumed = context.resume().catch(() => {});
					let stream;
					try {
						stream = await navigator.mediaDevices.getUserMedia({
							audio: deviceId === "" ? true : { deviceId: { exact: deviceId } },
							video: false
						});
					} catch (error) {
						await context.close().catch(() => {});
						throw classifyMediaError(error);
					}
					const tracks = stream.getAudioTracks();
					try {
						if (tracks.length === 0) throw new CaptureError("no-device", "the granted stream has no audio track");
						await Promise.race([resumed, new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS))]);
						if (context.state !== "running") throw new CaptureError("capture-failed", `audio engine did not start (state ${context.state})`);
						return await tapStream(stream, context, tracks[0], onFrames, onEnded);
					} catch (error) {
						for (const track of stream.getTracks()) track.stop();
						await context.close().catch(() => {});
						throw error instanceof CaptureError ? error : new CaptureError("capture-failed", String(error));
					}
				}
			};
		}
		/** How long a suspended capture context may take to start before the recording is refused. */
		const RESUME_TIMEOUT_MS = 3e3;
		async function tapStream(stream, context, track, onFrames, onEnded) {
			const source = context.createMediaStreamSource(stream);
			const sink = context.createGain();
			sink.gain.value = 0;
			sink.connect(context.destination);
			let tap;
			let closed = false;
			const worklet = await openWorklet(context);
			if (worklet !== void 0) {
				worklet.port.onmessage = (event) => {
					if (!closed) onFrames(event.data);
				};
				tap = worklet;
			} else {
				const processor = context.createScriptProcessor(4096, Math.max(1, Math.min(2, source.channelCount)), 1);
				processor.onaudioprocess = (event) => {
					if (closed) return;
					const input = event.inputBuffer;
					const mono = new Float32Array(input.length);
					for (let c = 0; c < input.numberOfChannels; c++) {
						const channel = input.getChannelData(c);
						for (let i = 0; i < mono.length; i++) mono[i] += channel[i];
					}
					if (input.numberOfChannels > 1) for (let i = 0; i < mono.length; i++) mono[i] /= input.numberOfChannels;
					onFrames(mono);
				};
				tap = processor;
			}
			source.connect(tap);
			tap.connect(sink);
			const ended = () => {
				if (!closed) onEnded();
			};
			track.addEventListener("ended", ended);
			const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
			return {
				sampleRate: context.sampleRate,
				deviceLabel: track.label,
				deviceId: typeof settings.deviceId === "string" ? settings.deviceId : "",
				async close() {
					if (closed) return;
					closed = true;
					track.removeEventListener("ended", ended);
					for (const t of stream.getTracks()) t.stop();
					source.disconnect();
					tap.disconnect();
					sink.disconnect();
					await context.close().catch(() => {});
				}
			};
		}
		async function openWorklet(context) {
			if (context.audioWorklet === void 0 || typeof AudioWorkletNode !== "function") return void 0;
			const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
			try {
				await context.audioWorklet.addModule(url);
				return new AudioWorkletNode(context, WORKLET_NAME, {
					numberOfInputs: 1,
					numberOfOutputs: 1,
					outputChannelCount: [1]
				});
			} catch {
				return;
			} finally {
				URL.revokeObjectURL(url);
			}
		}
		//#endregion
		//#region src/client/wav.ts
		/** Half-width of the windowed-sinc kernel, in input-rate zero crossings. */
		const KERNEL_ZERO_CROSSINGS = 12;
		/**
		* {@link resampleMono} in bounded slices that yield to the event loop, so a
		* long clip does not freeze the recording panel while it is prepared.
		* @param input - mono samples in [-1, 1].
		* @param fromRate - input sample rate in Hz.
		* @param toRate - output sample rate in Hz.
		* @param signal - optional cancellation checked between slices.
		* @returns the resampled samples.
		*/
		async function resampleMonoAsync(input, fromRate, toRate, signal) {
			const plan = resamplePlan(input, fromRate, toRate);
			if (plan === void 0) return input;
			const slice = 16384;
			for (let start = 0; start < plan.output.length; start += slice) {
				signal?.throwIfAborted();
				resampleRange(input, plan, start, Math.min(plan.output.length, start + slice));
				await new Promise((resolve) => {
					setTimeout(resolve, 0);
				});
			}
			return plan.output;
		}
		/** Kernel table resolution per input sample; linear interpolation between entries. */
		const TABLE_DENSITY = 512;
		function resamplePlan(input, fromRate, toRate) {
			if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError(`invalid sample rates ${fromRate} -> ${toRate}`);
			if (fromRate === toRate || input.length === 0) return void 0;
			const ratio = toRate / fromRate;
			const cutoff = Math.min(1, ratio) * .95;
			const halfWidth = KERNEL_ZERO_CROSSINGS / cutoff;
			const table = new Float32Array(Math.ceil(2 * halfWidth * TABLE_DENSITY) + 2);
			for (let i = 0; i < table.length; i++) table[i] = kernel(i / TABLE_DENSITY - halfWidth, cutoff, halfWidth);
			return {
				output: new Float32Array(Math.max(1, Math.round(input.length * ratio))),
				halfWidth,
				step: 1 / ratio,
				table
			};
		}
		function resampleRange(input, plan, from, to) {
			const { output, halfWidth, step, table } = plan;
			const last = input.length - 1;
			const tableLast = table.length - 2;
			for (let n = from; n < to; n++) {
				const center = n * step;
				const kFirst = Math.max(0, Math.ceil(center - halfWidth));
				const kLast = Math.min(last, Math.floor(center + halfWidth));
				let sum = 0;
				let weight = 0;
				for (let k = kFirst; k <= kLast; k++) {
					const position = (k - center + halfWidth) * TABLE_DENSITY;
					const index = Math.min(tableLast, Math.max(0, Math.floor(position)));
					const fraction = position - index;
					const w = table[index] + (table[index + 1] - table[index]) * fraction;
					sum += input[k] * w;
					weight += w;
				}
				output[n] = weight === 0 ? 0 : sum / weight;
			}
		}
		function kernel(x, cutoff, halfWidth) {
			if (Math.abs(x) >= halfWidth) return 0;
			const sinc = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
			const phase = (x / halfWidth + 1) / 2;
			return sinc * (.42 - .5 * Math.cos(2 * Math.PI * phase) + .08 * Math.cos(4 * Math.PI * phase));
		}
		/**
		* Encode mono samples as a canonical 44-byte-header PCM16 WAV.
		* @param samples - mono samples; values outside [-1, 1] are clipped.
		* @param sampleRate - sample rate written to the header.
		* @returns the complete file bytes and its format facts.
		*/
		function encodeWavPcm16(samples, sampleRate) {
			if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`invalid sample rate ${sampleRate}`);
			const dataBytes = samples.length * 2;
			const bytes = new Uint8Array(44 + dataBytes);
			const view = new DataView(bytes.buffer);
			writeAscii(bytes, 0, "RIFF");
			view.setUint32(4, 36 + dataBytes, true);
			writeAscii(bytes, 8, "WAVE");
			writeAscii(bytes, 12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, sampleRate, true);
			view.setUint32(28, sampleRate * 2, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			writeAscii(bytes, 36, "data");
			view.setUint32(40, dataBytes, true);
			for (let i = 0; i < samples.length; i++) {
				const s = Math.max(-1, Math.min(1, samples[i]));
				view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
			}
			return {
				bytes,
				sampleRate,
				channels: 1,
				bitsPerSample: 16,
				frames: samples.length,
				durationMs: Math.round(samples.length * 1e3 / sampleRate)
			};
		}
		function writeAscii(target, offset, text) {
			for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i);
		}
		/**
		* Concatenate captured frame chunks into one buffer.
		* @param chunks - captured mono chunks in arrival order.
		* @param frames - total frame count across the chunks.
		* @returns contiguous samples.
		*/
		function joinChunks(chunks, frames) {
			const joined = new Float32Array(frames);
			let offset = 0;
			for (const chunk of chunks) {
				const take = Math.min(chunk.length, frames - offset);
				joined.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
				offset += take;
				if (offset >= frames) break;
			}
			return joined;
		}
		/**
		* Lowercase hex SHA-256 through Web Crypto.
		* @param bytes - data to hash.
		* @returns the digest, or undefined when SubtleCrypto is unavailable (non-secure context).
		*/
		async function sha256Hex(bytes) {
			const subtle = globalThis.crypto?.subtle;
			if (subtle === void 0) return void 0;
			const digest = await subtle.digest("SHA-256", bytes);
			return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
		}
		//#endregion
		//#region src/client/audio/options.ts
		const OBLIGATIONS = new Set([
			"required",
			"required-conditional",
			"offer-restricted",
			"offer-unverified",
			"rejected-conditional",
			"rejected",
			"unsupported",
			"not-forwarded",
			"ignored",
			"conflict",
			"unknown",
			"unlisted"
		]);
		/** Obligations that name an explicit negative (no usable control). */
		const NEGATIVE_OBLIGATIONS = new Set([
			"rejected-conditional",
			"rejected",
			"unsupported",
			"not-forwarded",
			"ignored",
			"conflict"
		]);
		const text = (value) => typeof value === "string" && value !== "" ? value : void 0;
		/**
		* Read a capability entry's option controls.
		* @param entry - capability entry facts: `optionControls`, `requestOptionsMap` (for raw texts), `requestOptionsScope`.
		* @returns facts; `source: none` when the host publishes no `optionControls@1`.
		*/
		function optionFacts(entry) {
			const oc = entry.optionControls;
			if (oc?.contract !== "dsh-audio/option-controls@1" || !Array.isArray(oc.controls)) return {
				source: "none",
				basis: void 0,
				family: void 0,
				scope: void 0,
				byKey: {},
				blockers: [],
				notSendable: [],
				unmapped: [],
				hostOptions: [],
				inputErrors: []
			};
			const map = Array.isArray(entry.requestOptionsMap) ? entry.requestOptionsMap : [];
			const rawAt = (index) => typeof index === "number" ? text(map[index]?.raw) : void 0;
			const byKey = {};
			for (const item of oc.controls) {
				const c = item;
				if (typeof c?.key !== "string") continue;
				const known = typeof c.obligation === "string" && OBLIGATIONS.has(c.obligation);
				const obligation = known ? c.obligation : "unknown";
				const entries = Array.isArray(c.entries) ? c.entries : [];
				const raw = entries.map((e) => rawAt(e?.index)).filter((r) => r !== void 0);
				const restricted = entries.filter((e) => e?.status === "listed-restricted").map((e) => rawAt(e.index)).filter((r) => r !== void 0);
				byKey[c.key] = {
					key: c.key,
					wire: text(c.wireKey),
					kind: c.kind === "attachment" ? "attachment" : "param",
					obligation,
					active: c.active === true && known && !NEGATIVE_OBLIGATIONS.has(obligation) && obligation !== "unknown" && obligation !== "unlisted",
					mandatory: c.mandatory === true ? true : c.mandatory === "conditional" ? "conditional" : false,
					reason: text(c.reason),
					conditions: Array.isArray(c.conditions) ? c.conditions.filter((s) => typeof s === "string") : [],
					raw,
					restriction: obligation === "offer-restricted" ? restricted.join("; ") || void 0 : void 0,
					delivery: c.delivery === "final-header" || c.delivery === "live.words" ? c.delivery : void 0,
					note: text(c.note),
					deploymentDefault: c.deploymentDefault === true
				};
			}
			const issues = (value) => (Array.isArray(value) ? value : []).map((item) => {
				const i = item;
				return {
					option: text(i?.option),
					wireKey: text(i?.wireKey),
					status: text(i?.status),
					reason: text(i?.reason),
					raw: rawAt(i?.index)
				};
			});
			return {
				source: "option-controls",
				basis: oc.basis === "catalog-map" || oc.basis === "catalog-map-empty" || oc.basis === "raw-only" || oc.basis === "none" ? oc.basis : void 0,
				family: text(oc.family),
				scope: text(entry.requestOptionsScope),
				byKey,
				blockers: issues(oc.blockers),
				notSendable: issues(oc.notSendable),
				unmapped: issues(oc.unmapped),
				hostOptions: issues(oc.hostOptions),
				inputErrors: (Array.isArray(oc.inputErrors) ? oc.inputErrors : []).map((e) => e).filter((e) => typeof e?.field === "string").map((e) => ({
					field: String(e.field),
					message: String(e.message ?? "")
				}))
			};
		}
		/**
		* Decide how a UI key is offered.
		* @param facts - option facts of the variant.
		* @param key - UI key.
		* @param configured - the deployment set a value (descriptor `default`); used only without `optionControls`.
		* @param serverChoices - the server reported non-empty choices (voices); used only without `optionControls`.
		* @returns offer state; only the `required*` and `offered-*` states render a control.
		*/
		function offerFor(facts, key, configured, serverChoices) {
			if (facts.source === "option-controls") {
				const fact = facts.byKey[key];
				if (fact === void 0) return "unknown";
				if (fact.active) {
					if (fact.mandatory === true) return "required";
					if (fact.mandatory === "conditional") return "required-conditional";
					return fact.obligation === "offer-restricted" ? "offered-restricted" : "offered-unverified";
				}
				if (NEGATIVE_OBLIGATIONS.has(fact.obligation)) return "not-offered";
				return fact.obligation === "unlisted" ? "unlisted" : "unknown";
			}
			if (configured) return "offered-configured";
			if (serverChoices) return "offered-server";
			return "unknown";
		}
		/**
		* Whether an offer state renders a control.
		* @param offer - offer state.
		* @returns true when a control is shown.
		*/
		function rendersControl(offer) {
			return offer === "required" || offer === "required-conditional" || offer === "offered-restricted" || offer === "offered-unverified" || offer === "offered-configured" || offer === "offered-server";
		}
		/**
		* Input need of an attachment slot from its control: active → optional (required when mandatory, or when the host's
		* own io already requires it); otherwise none.
		* @param facts - option facts.
		* @param key - attachment key.
		* @param ioNeed - the host's io tri-state for the same slot (it only tightens an active control, never enables one).
		* @returns need.
		*/
		function slotNeed(facts, key, ioNeed) {
			const fact = facts.byKey[key];
			if (fact?.active !== true) return "none";
			return fact.mandatory === true || ioNeed === "required" ? "required" : "optional";
		}
		//#endregion
		//#region src/client/audio/tasks.ts
		/** Closed UI task list (`uiTask`, TASK_CONTRACT 0.2 §F). */
		const AUDIO_TASKS = [
			"chat",
			"audio-chat",
			"omni-chat",
			"asr",
			"translation",
			"diarization",
			"tts",
			"voice-clone",
			"s2s",
			"realtime-asr",
			"duplex",
			"tts-stream",
			"music-generation",
			"sound-generation",
			"audio-edit",
			"enhancement",
			"separation",
			"audio-embedding",
			"video-generation",
			"alignment"
		];
		/** Attachment slots a request can name in the options block (TASK_CONTRACT 0.2 §J.2 speech, §K.7 video). */
		const REFERENCE_SLOTS = [
			"referenceAudio",
			"referenceAudio2",
			"emotionAudio",
			"imageReference",
			"audioReference"
		];
		const NEEDS = [
			"none",
			"optional",
			"required"
		];
		function need(value, fallback) {
			return typeof value === "string" && NEEDS.includes(value) ? value : fallback;
		}
		function isTask(value) {
			return typeof value === "string" && AUDIO_TASKS.includes(value);
		}
		/** Default input needs per task when `io.input` is absent. */
		const TASK_INPUTS = {
			"chat": {
				text: "required",
				audio: "none",
				referenceAudio: "none",
				referenceText: "none"
			},
			"audio-chat": {
				text: "optional",
				audio: "required",
				referenceAudio: "none",
				referenceText: "none"
			},
			"omni-chat": {
				text: "optional",
				audio: "optional",
				referenceAudio: "none",
				referenceText: "none"
			},
			"asr": {
				text: "none",
				audio: "required",
				referenceAudio: "none",
				referenceText: "none"
			},
			"translation": {
				text: "none",
				audio: "required",
				referenceAudio: "none",
				referenceText: "none"
			},
			"diarization": {
				text: "none",
				audio: "required",
				referenceAudio: "none",
				referenceText: "none"
			},
			"tts": {
				text: "required",
				audio: "none",
				referenceAudio: "none",
				referenceText: "none"
			},
			"voice-clone": {
				text: "required",
				audio: "none",
				referenceAudio: "required",
				referenceText: "optional"
			},
			"s2s": {
				text: "none",
				audio: "required",
				referenceAudio: "optional",
				referenceText: "none"
			},
			"realtime-asr": {
				text: "none",
				audio: "required",
				referenceAudio: "none",
				referenceText: "none"
			},
			"tts-stream": {
				text: "required",
				audio: "none",
				referenceAudio: "none",
				referenceText: "none"
			},
			"duplex": {
				text: "none",
				audio: "required",
				referenceAudio: "optional",
				referenceText: "none"
			},
			"music-generation": {
				text: "required",
				audio: "optional",
				referenceAudio: "none",
				referenceText: "none"
			},
			"sound-generation": {
				text: "required",
				audio: "none",
				referenceAudio: "none",
				referenceText: "none"
			},
			"audio-edit": {
				text: "required",
				audio: "required",
				referenceAudio: "none",
				referenceText: "none"
			},
			"enhancement": {
				text: "none",
				audio: "required",
				referenceAudio: "none",
				referenceText: "none"
			},
			"separation": {
				text: "none",
				audio: "required",
				referenceAudio: "none",
				referenceText: "none"
			},
			"audio-embedding": {
				text: "none",
				audio: "required",
				referenceAudio: "none",
				referenceText: "none"
			},
			"video-generation": {
				text: "required",
				audio: "none",
				referenceAudio: "none",
				referenceText: "none"
			},
			"alignment": {
				text: "required",
				audio: "required",
				referenceAudio: "none",
				referenceText: "none"
			}
		};
		/** Tasks whose normal output is generated audio. */
		const AUDIO_OUTPUT_TASKS = new Set([
			"omni-chat",
			"tts",
			"voice-clone",
			"s2s",
			"duplex",
			"tts-stream",
			"music-generation",
			"sound-generation",
			"audio-edit",
			"enhancement",
			"separation"
		]);
		/** Tasks whose audio is heard as the other side of a conversation. */
		const SPEAKING_TASKS = new Set([
			"omni-chat",
			"s2s",
			"duplex"
		]);
		function stateOf(model, name) {
			return model.capabilities[name]?.state ?? "unsupported";
		}
		/**
		* Infer a task for a model without a declared `task`.
		* @param model - capability entry.
		* @returns the closest task the published facts support.
		*/
		function inferTask(model) {
			if (model.mode === "transcribe") return "asr";
			if (model.mode === "realtime") return model.output?.audio === true || stateOf(model, "audioOutput") !== "unsupported" || stateOf(model, "fullDuplex") !== "unsupported" ? "duplex" : "realtime-asr";
			if (model.output?.audio === true) return "omni-chat";
			if (model.input?.formats !== void 0 && model.input.formats.length > 0) return "audio-chat";
			return "chat";
		}
		/**
		* Resolve the task view of a capability entry.
		* @param model - capability entry (possibly carrying proposal fields).
		* @returns the task view.
		*/
		function taskView(model) {
			const raw = model;
			const declared = isTask(raw.uiTask) || isTask(raw.task);
			const task = isTask(raw.uiTask) ? raw.uiTask : isTask(raw.task) ? raw.task : inferTask(model);
			const adapterTask = typeof raw.task === "string" && (isTask(raw.uiTask) || !isTask(raw.task)) ? raw.task : void 0;
			const wire = typeof raw.wire === "string" ? raw.wire : void 0;
			const base = TASK_INPUTS[task];
			const inputs = raw.io?.input ?? {};
			const options = optionFacts(raw);
			const video = task === "video-generation";
			const mainNeed = (key, io) => {
				const fact = options.byKey[key];
				if (fact !== void 0 && NEGATIVE_OBLIGATIONS.has(fact.obligation)) return "none";
				return fact?.active === true && fact.mandatory === true ? "required" : io;
			};
			const outputs = raw.io?.output ?? {};
			const transcript = outputs.transcript ?? {};
			const audioOut = typeof outputs.audio === "boolean" ? outputs.audio : model.output?.audio ?? AUDIO_OUTPUT_TASKS.has(task);
			const transcriptTask = task === "asr" || task === "translation" || task === "diarization" || task === "realtime-asr";
			return {
				task,
				source: declared ? "declared" : "inferred",
				input: {
					text: need(inputs.text, base.text),
					audio: video ? "none" : need(inputs.audio, base.audio),
					referenceAudio: mainNeed("referenceAudio", need(inputs.referenceAudio, base.referenceAudio)),
					referenceText: mainNeed("refText", need(inputs.referenceText, base.referenceText)),
					referenceAudio2: slotNeed(options, "referenceAudio2", need(inputs.referenceAudio2, "none")),
					emotionAudio: slotNeed(options, "emotionAudio", need(inputs.emotionAudio, "none")),
					imageReference: video ? slotNeed(options, "imageReference", need(inputs.image, "none")) : "none",
					audioReference: video ? slotNeed(options, "audioReference", need(inputs.audio, "none")) : "none"
				},
				output: {
					text: typeof outputs.text === "boolean" ? outputs.text : model.output?.text ?? (!AUDIO_OUTPUT_TASKS.has(task) || task === "omni-chat" || task === "duplex"),
					audio: audioOut,
					audioCount: outputs.audioCount === "many" || task === "separation" ? "many" : "one",
					segments: typeof transcript.segments === "boolean" ? transcript.segments : transcriptTask,
					wordTimestamps: transcript.wordTimestamps === true,
					speakers: typeof transcript.speakers === "boolean" ? transcript.speakers : task === "diarization",
					embedding: typeof outputs.embedding === "boolean" ? outputs.embedding : task === "audio-embedding",
					video: typeof outputs.video === "boolean" ? outputs.video : video
				},
				speaks: audioOut && SPEAKING_TASKS.has(task),
				live: liveKind(model, task, adapterTask, raw.io?.live, audioOut),
				adapterTask,
				wire,
				catalogTasks: Array.isArray(raw.catalogTasks) ? raw.catalogTasks.filter((t) => typeof t === "string") : [],
				options,
				params: Array.isArray(raw.params) ? raw.params.map(toParam).filter((p) => p !== void 0) : [],
				limits: {
					...typeof raw.limits?.maxInputSeconds === "number" ? { maxInputSeconds: raw.limits.maxInputSeconds } : {},
					...typeof raw.limits?.maxReferenceSeconds === "number" ? { maxReferenceSeconds: raw.limits.maxReferenceSeconds } : {},
					...typeof raw.limits?.maxTextChars === "number" ? { maxTextChars: raw.limits.maxTextChars } : {}
				}
			};
		}
		function liveKind(model, task, adapterTask, ioLive, audioOut) {
			if (ioLive === "text" || adapterTask === "tts.stream-input" || task === "tts-stream") return "text-input";
			const realtime = ioLive === "audio" || model.mode === "realtime";
			if (adapterTask === "asr.realtime" || task === "realtime-asr") return "transcription";
			if (adapterTask === "speech.s2s.realtime" || realtime && task === "s2s") return "turn";
			if (adapterTask === "duplex" || task === "duplex") return audioOut ? "conversation" : "transcription";
			return "none";
		}
		const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
		/** Run-time value lists may only come from adapter routes (e.g. `GET …/voices`). */
		function valuesFromOf$1(p) {
			return typeof p.valuesFrom === "string" && p.valuesFrom.startsWith("/api/dsh-dgx-audio/v1/") ? p.valuesFrom : void 0;
		}
		function toParam(value) {
			if (typeof value !== "object" || value === null) return void 0;
			const p = value;
			if (typeof p.key !== "string" || !PARAM_KEY.test(p.key)) return void 0;
			const common = {
				key: p.key,
				...typeof p.label === "string" ? { label: p.label } : {}
			};
			const num = (k) => typeof p[k] === "number" && Number.isFinite(p[k]) ? { [k]: p[k] } : {};
			switch (p.type) {
				case "enum": {
					const values = Array.isArray(p.values) ? p.values.filter((v) => typeof v === "string") : [];
					const valuesFrom = valuesFromOf$1(p);
					if (values.length === 0 && valuesFrom === void 0) return void 0;
					return {
						...common,
						type: "enum",
						values,
						...valuesFrom === void 0 ? {} : { valuesFrom },
						...typeof p.default === "string" ? { default: p.default } : {}
					};
				}
				case "number":
				case "integer": return {
					...common,
					type: p.type,
					...num("min"),
					...num("max"),
					...num("step"),
					...num("default")
				};
				case "text":
				case "string": return {
					...common,
					type: p.type,
					...num("maxLength"),
					...valuesFromOf$1(p) === void 0 ? {} : { valuesFrom: valuesFromOf$1(p) },
					...typeof p.default === "string" ? { default: p.default } : {}
				};
				case "list": return {
					...common,
					type: "list",
					...num("maxLength"),
					...Array.isArray(p.default) ? { default: p.default.filter((v) => typeof v === "string") } : {}
				};
				case "boolean": return {
					...common,
					type: "boolean",
					...typeof p.default === "boolean" ? { default: p.default } : {}
				};
				case "object": return {
					...common,
					type: "object",
					maxBytes: typeof p.maxBytes === "number" ? p.maxBytes : 16e3,
					...isPlainObject(p.default) ? { default: p.default } : {}
				};
				default: return;
			}
		}
		function isPlainObject(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		/**
		* Parse a JSON object typed into an object parameter.
		* @param text - JSON text.
		* @returns the object, or undefined when the text is not a JSON object.
		*/
		function parseJsonObject(text) {
			if (text.trim() === "") return void 0;
			try {
				const value = JSON.parse(text);
				return isPlainObject(value) ? value : void 0;
			} catch {
				return;
			}
		}
		/**
		* Offer state of one parameter (TASK_CONTRACT §K.11 option controls; see `options.ts`).
		* @param view - task view.
		* @param param - descriptor.
		* @param serverValues - choices the server reported for a `valuesFrom` parameter (undefined while unknown).
		* @returns offer state.
		*/
		function offerOf(view, param, serverValues) {
			const serverChoices = "valuesFrom" in param && param.valuesFrom !== void 0 && serverValues !== void 0 && serverValues.length > 0;
			return offerFor(view.options, param.key, param.default !== void 0, serverChoices);
		}
		/**
		* Requirements the draft does not satisfy yet.
		* @param view - task view.
		* @param draft - current inputs.
		* @returns missing requirement codes in display order.
		*/
		function missingInputs(view, draft) {
			const missing = [];
			const ambient = draft.options?.ambientSound;
			const describedByAmbient = typeof ambient === "string" && ambient.trim() !== "";
			if (view.input.text === "required" && draft.text.trim() === "" && !describedByAmbient) missing.push("text");
			if (view.limits.maxTextChars !== void 0 && draft.text.length > view.limits.maxTextChars) missing.push("textTooLong");
			if (view.input.audio === "required" && !draft.hasAudio) missing.push("audio");
			if (view.input.referenceAudio === "required" && !draft.hasReference) missing.push("referenceAudio");
			if ((draft.requiredOptionsMissing?.length ?? 0) > 0) missing.push("requiredOption");
			for (const slot of [
				"referenceAudio2",
				"emotionAudio",
				"imageReference",
				"audioReference"
			]) if (view.input[slot] === "required" && draft.extraReferences?.[slot]?.present !== true) missing.push(slot);
			const extraWithoutConsent = Object.values(draft.extraReferences ?? {}).some((r) => r?.present === true && !r.consent);
			if (draft.hasReference && !draft.referenceConsent || extraWithoutConsent) missing.push("referenceConsent");
			if (view.input.referenceText === "required" && draft.referenceText.trim() === "") missing.push("referenceText");
			return missing;
		}
		/**
		* Coerce option values against the descriptors; unknown keys are dropped, out-of-range numbers clamped.
		* @param params - descriptors.
		* @param values - user values keyed by param key.
		* @param includeDefaults - fill unset keys with descriptor defaults (display); requests send only user-set keys.
		* @returns validated options.
		*/
		function resolveOptions(params, values, includeDefaults = true) {
			const out = {};
			for (const param of params) {
				const value = values[param.key] ?? (includeDefaults ? param.default : void 0);
				if (value === void 0) continue;
				switch (param.type) {
					case "enum":
						if (typeof value === "string" && (param.values.includes(value) || param.valuesFrom !== void 0 && value !== "")) out[param.key] = value;
						else if (includeDefaults && param.default !== void 0 && param.values.includes(param.default)) out[param.key] = param.default;
						break;
					case "number":
					case "integer": {
						const raw = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
						if (!Number.isFinite(raw)) break;
						const integral = param.type === "integer" || param.step !== void 0 && Number.isInteger(param.step) && param.step >= 1;
						const unit = param.type === "integer" ? 1 : param.step ?? 1;
						let n = integral ? Math.round(raw / unit) * unit : raw;
						if (param.min !== void 0) n = Math.max(param.min, n);
						if (param.max !== void 0) n = Math.min(param.max, n);
						out[param.key] = n;
						break;
					}
					case "text":
					case "string":
						if (typeof value === "string" && value !== "") out[param.key] = param.maxLength === void 0 ? value : value.slice(0, param.maxLength);
						break;
					case "list": {
						const items = (Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,]/) : []).filter((v) => typeof v === "string").map((v) => v.trim()).filter((v) => v !== "");
						if (items.length > 0) out[param.key] = param.maxLength === void 0 ? items : items.slice(0, param.maxLength);
						break;
					}
					case "boolean":
						if (typeof value === "boolean") out[param.key] = value;
						break;
					case "object": {
						const parsed = typeof value === "string" ? parseJsonObject(value) : isPlainObject(value) ? value : void 0;
						if (parsed !== void 0 && Object.keys(parsed).length > 0 && JSON.stringify(parsed).length <= (param.maxBytes ?? 16e3)) out[param.key] = parsed;
						break;
					}
					default: break;
				}
			}
			return out;
		}
		/**
		* Inline options block (TASK_CONTRACT 0.2 §H, normative carrier) placed before the request text.
		* @param model - Harness model id.
		* @param options - validated options.
		* @param reference - reference attachment name and optional transcript.
		* @returns fenced JSON block text.
		*/
		function optionsBlock(model, options, reference) {
			const payload = {
				v: 1,
				model,
				...options,
				...reference?.name === void 0 ? {} : {
					referenceAudio: reference.name,
					...reference.text === void 0 ? {} : { referenceText: reference.text }
				},
				...reference?.referenceAudio2 === void 0 ? {} : { referenceAudio2: reference.referenceAudio2 },
				...reference?.emotionAudio === void 0 ? {} : { emotionAudio: reference.emotionAudio },
				...reference?.imageReference === void 0 ? {} : { imageReference: reference.imageReference },
				...reference?.audioReference === void 0 ? {} : { audioReference: reference.audioReference }
			};
			return "```dsh-audio-options\n" + JSON.stringify(payload) + "\n```";
		}
		/**
		* One prompt text part: the options block, a blank line, then the user's text (Harness joins adjacent text parts without a separator).
		* @param block - options block, or undefined for plain text.
		* @param text - request text.
		* @returns prompt text.
		*/
		function withOptions(block, text) {
			if (block === void 0) return text;
			return text === "" ? block : `${block}\n\n${text}`;
		}
		/**
		* Voice names from `GET …/voices` (`voices` passthrough entries may be strings or objects; `uploadedVoices[].name`).
		* @param body - route response.
		* @returns unique names in server order.
		*/
		function voiceNames(body) {
			if (typeof body !== "object" || body === null) return [];
			const record = body;
			const names = [];
			for (const list of [record.voices, record.uploadedVoices]) {
				if (!Array.isArray(list)) continue;
				for (const item of list) {
					const name = typeof item === "string" ? item : typeof item === "object" && item !== null ? [
						"name",
						"voice",
						"id"
					].map((k) => item[k]).find((v) => typeof v === "string") : void 0;
					if (name !== void 0 && name !== "" && !names.includes(name)) names.push(name);
				}
			}
			return names;
		}
		//#endregion
		//#region src/client/controller.ts
		/** Documented defaults; 16 kHz mono PCM16 matches the verified audio-attachment route. */
		const DEFAULT_SPEC = {
			maxDurationMs: 12e4,
			minDurationMs: 300,
			targetSampleRate: 16e3,
			meterIntervalMs: 100
		};
		/** Remember-device storage key (best effort; absent storage keeps the default). */
		const DEVICE_KEY = "dsh-voice-capture.deviceId";
		/** Per-page recording controller shared by every Session composer. */
		var VoiceCaptureController = class {
			backend;
			upload;
			sessions;
			spec;
			clock;
			storage;
			micBusyElsewhere;
			states = /* @__PURE__ */ new Map();
			sources = /* @__PURE__ */ new Map();
			listeners = /* @__PURE__ */ new Set();
			devices = [];
			selectedDeviceId = "";
			active;
			disposed = false;
			unwatchDevices;
			/**
			* @param backend - media access.
			* @param upload - file upload service.
			* @param sessions - Session bindings.
			* @param spec - limits and format.
			* @param clock - monotonic milliseconds (injectable for tests).
			* @param storage - device preference storage, when available.
			* @param micBusyElsewhere - whether another feature (Live mode) holds the microphone.
			*/
			constructor(backend, upload, sessions, spec = DEFAULT_SPEC, clock = () => performance.now(), storage = safeLocalStorage(), micBusyElsewhere = () => false) {
				this.backend = backend;
				this.upload = upload;
				this.sessions = sessions;
				this.spec = spec;
				this.clock = clock;
				this.storage = storage;
				this.micBusyElsewhere = micBusyElsewhere;
				this.selectedDeviceId = readPreference(storage);
				this.unwatchDevices = backend.support() === void 0 ? backend.onDeviceChange(() => {
					this.refreshDevices();
				}) : () => {};
			}
			/**
			* Identity-stable observable for one Session.
			* @param sessionId - Session whose composer renders the controls.
			* @returns the source (same object for the same id).
			*/
			source(sessionId) {
				let source = this.sources.get(sessionId);
				if (source === void 0) {
					source = {
						getSnapshot: () => this.snapshotOf(sessionId),
						subscribe: (listener) => {
							this.listeners.add(listener);
							return () => {
								this.listeners.delete(listener);
							};
						}
					};
					this.sources.set(sessionId, source);
				}
				return source;
			}
			/**
			* Start recording for a Session. Only a direct user action may call this.
			* @param sessionId - Session that will own the clip.
			*/
			async start(sessionId) {
				if (this.disposed) return;
				const state = this.state(sessionId);
				if (state.phase === "requesting" || state.phase === "recording" || state.phase === "encoding" || state.phase === "sending") return;
				const unsupported = this.backend.support();
				if (unsupported !== void 0) {
					this.fail(sessionId, unsupported, "");
					return;
				}
				if (this.active !== void 0 || this.micBusyElsewhere()) {
					this.fail(sessionId, "busy-elsewhere", "");
					return;
				}
				this.releaseClip(state);
				state.error = void 0;
				state.phase = "requesting";
				const capture = {
					sessionId,
					session: void 0,
					chunks: [],
					frames: 0,
					maxFrames: Number.POSITIVE_INFINITY,
					level: 0,
					startedAt: this.clock(),
					meter: void 0,
					finishing: false,
					pendingStop: void 0
				};
				this.active = capture;
				this.publish(sessionId);
				let opened;
				try {
					opened = await this.backend.open({
						deviceId: this.selectedDeviceId,
						onFrames: (chunk) => this.onFrames(capture, chunk),
						onEnded: () => {
							this.stop(sessionId);
						}
					});
				} catch (error) {
					if (this.active === capture) this.active = void 0;
					if (state.phase !== "requesting") return;
					const failure = error instanceof CaptureError ? error.failure : "capture-failed";
					if (failure === "no-device" && this.selectedDeviceId !== "") this.selectDevice("");
					this.fail(sessionId, failure, error instanceof Error ? error.message : String(error));
					this.refreshDevices();
					return;
				}
				capture.session = opened;
				if (this.disposed || this.active !== capture || capture.pendingStop === "cancel") {
					await opened.close();
					if (this.active === capture) this.active = void 0;
					if (state.phase === "requesting") {
						state.phase = "idle";
						this.publish(sessionId);
					}
					return;
				}
				capture.maxFrames = Math.floor(opened.sampleRate * this.spec.maxDurationMs / 1e3);
				capture.startedAt = this.clock();
				state.phase = "recording";
				capture.meter = setInterval(() => {
					this.publish(sessionId);
				}, this.spec.meterIntervalMs);
				this.publish(sessionId);
				this.refreshDevices();
				if (capture.pendingStop === "stop") await this.stop(sessionId);
			}
			/**
			* Stop recording and prepare the preview clip.
			* @param sessionId - Session that owns the capture.
			*/
			async stop(sessionId) {
				const capture = this.active;
				if (capture === void 0 || capture.sessionId !== sessionId) return;
				if (capture.session === void 0) {
					capture.pendingStop = "stop";
					return;
				}
				await this.finish(capture, false);
			}
			/**
			* Discard the recording or clip, or abort an in-flight send (the clip is kept).
			* @param sessionId - Session whose panel issued the cancel.
			*/
			async cancel(sessionId) {
				const state = this.state(sessionId);
				const capture = this.active;
				if (capture !== void 0 && capture.sessionId === sessionId) {
					if (capture.session === void 0) {
						capture.pendingStop = "cancel";
						state.phase = "idle";
						this.publish(sessionId);
						return;
					}
					this.active = void 0;
					capture.finishing = true;
					clearInterval(capture.meter);
					capture.chunks.length = 0;
					await capture.session.close();
					state.phase = "idle";
					this.publish(sessionId);
					return;
				}
				if (state.phase === "sending") {
					state.sendAbort?.abort();
					return;
				}
				this.releaseClip(state);
				state.error = void 0;
				state.phase = "idle";
				this.publish(sessionId);
			}
			/**
			* Upload the prepared clip and prompt the Session with it.
			* @param sessionId - Session that owns the clip.
			* @param text - optional prompt text sent after the audio part.
			* @returns the settlement.
			*/
			async send(sessionId, text, extras = {}) {
				const state = this.state(sessionId);
				const clip = state.clip;
				if (state.phase !== "preview" || clip === void 0) return "ignored";
				const notReady = extras.blocked?.();
				if (notReady !== void 0) {
					state.error = {
						code: "model-not-ready",
						detail: notReady
					};
					this.publish(sessionId);
					return "failed";
				}
				const abort = new AbortController();
				state.sendAbort = abort;
				state.error = void 0;
				state.phase = "sending";
				state.progress = {
					stage: "uploading",
					loaded: 0,
					total: clip.bytes
				};
				this.publish(sessionId);
				const settleBack = (code, detail) => {
					state.sendAbort = void 0;
					state.progress = void 0;
					if (abort.signal.aborted) {
						state.phase = "preview";
						this.publish(sessionId);
						return "cancelled";
					}
					state.phase = "preview";
					state.error = code === void 0 ? void 0 : {
						code,
						detail
					};
					this.publish(sessionId);
					return "failed";
				};
				let uploaded;
				try {
					const file = new File([clip.data], clip.name, { type: clip.mimeType });
					uploaded = await this.upload.upload(sessionId, file, clip.name, abort.signal, (progress) => {
						if (state.sendAbort !== abort) return;
						state.progress = {
							stage: "uploading",
							loaded: progress.loaded,
							total: progress.total ?? clip.bytes
						};
						this.publish(sessionId);
					});
				} catch (error) {
					return settleBack("upload-failed", error instanceof Error ? error.message : String(error));
				}
				if (!uploaded.ok) return settleBack("upload-failed", `${uploaded.error.code}: ${uploaded.error.message}`);
				if (abort.signal.aborted) return settleBack(void 0, "");
				const referenceClips = extras.references ?? (extras.reference === void 0 ? [] : [extras.reference]);
				const references = [];
				for (const clip of referenceClips) {
					try {
						const referenceUpload = await this.upload.upload(sessionId, clip.file, clip.name, abort.signal, () => {});
						if (!referenceUpload.ok) return settleBack("upload-failed", `${referenceUpload.error.code}: ${referenceUpload.error.message}`);
						references.push(referenceUpload.value);
					} catch (error) {
						return settleBack("upload-failed", error instanceof Error ? error.message : String(error));
					}
					if (abort.signal.aborted) return settleBack(void 0, "");
				}
				const binding = this.sessions.binding(sessionId);
				if (binding === void 0) return settleBack("session-unavailable", "");
				const stillNotReady = extras.blocked?.();
				if (stillNotReady !== void 0) return settleBack("model-not-ready", stillNotReady);
				state.progress = {
					stage: "submitting",
					loaded: clip.bytes,
					total: clip.bytes
				};
				this.publish(sessionId);
				const ref = uploaded.value.file;
				const combined = withOptions(extras.block, text);
				const textParts = combined === "" ? [] : [combined];
				const submission = binding.session.beginSubmission({
					mode: "queue",
					text: combined,
					attachments: [...references.map((reference) => ({
						type: "file",
						value: reference.file
					})), {
						type: "file",
						value: ref
					}]
				});
				let admitted;
				try {
					admitted = await binding.session.prompt([
						...references.map((reference) => ({
							type: "file",
							receiptId: reference.receiptId
						})),
						{
							type: "file",
							receiptId: uploaded.value.receiptId
						},
						...textParts.map((part) => ({
							type: "text",
							text: part
						}))
					], "queue", abort.signal, submission.requestId);
				} catch (error) {
					submission.abandon();
					return settleBack("prompt-failed", error instanceof Error ? error.message : String(error));
				}
				if (!admitted.ok) return settleBack("prompt-failed", `${admitted.error.code}: ${admitted.error.message}`);
				state.sendAbort = void 0;
				state.progress = void 0;
				state.lastSent = {
					name: clip.name,
					bytes: clip.bytes,
					sha256: clip.sha256,
					attachmentId: String(ref.attachmentId),
					attachmentBytes: ref.bytes,
					at: Date.now()
				};
				this.releaseClip(state);
				state.phase = "idle";
				this.publish(sessionId);
				return "sent";
			}
			/**
			* Take the prepared clip bytes out of the controller (reference-voice capture) and return to idle.
			* @param sessionId - Session that owns the clip.
			* @returns the WAV bytes and name, or undefined without a clip.
			*/
			takeClip(sessionId) {
				const state = this.state(sessionId);
				const clip = state.clip;
				if (clip === void 0 || state.phase !== "preview") return void 0;
				const taken = {
					data: clip.data,
					name: clip.name
				};
				this.releaseClip(state);
				state.phase = "idle";
				this.publish(sessionId);
				return taken;
			}
			/**
			* Choose the input device for the next recording.
			* @param deviceId - device id, `''` for the system default.
			*/
			selectDevice(deviceId) {
				this.selectedDeviceId = deviceId;
				try {
					this.storage?.setItem(DEVICE_KEY, deviceId);
				} catch {}
				this.publishAll();
			}
			/**
			* Clear a displayed error without discarding a prepared clip.
			* @param sessionId - Session whose panel dismissed the error.
			*/
			dismissError(sessionId) {
				const state = this.state(sessionId);
				state.error = void 0;
				if (state.phase === "error") state.phase = state.clip === void 0 ? "idle" : "preview";
				this.publish(sessionId);
			}
			/**
			* The Session's composer left the page (navigation or view change): stop a
			* capture it owns so no track outlives its controls. The clip is kept.
			* @param sessionId - Session whose controls unmounted.
			*/
			async detach(sessionId) {
				const capture = this.active;
				if (capture === void 0 || capture.sessionId !== sessionId) return;
				await this.stop(sessionId);
			}
			/** Re-read the input list (labels appear after permission). */
			async refreshDevices() {
				if (this.disposed || this.backend.support() !== void 0) return;
				try {
					this.devices = await this.backend.listDevices();
				} catch {
					return;
				}
				this.publishAll();
			}
			/** Release every capture, send and clip (plugin unload or page hide). */
			async dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.unwatchDevices();
				const capture = this.active;
				this.active = void 0;
				if (capture !== void 0) {
					capture.finishing = true;
					clearInterval(capture.meter);
					capture.pendingStop = "cancel";
					await capture.session?.close();
				}
				for (const state of this.states.values()) {
					state.sendAbort?.abort();
					this.releaseClip(state);
					state.phase = "idle";
				}
				this.publishAll();
				this.listeners.clear();
			}
			/** Whether a capture currently holds the microphone (for tests and diagnostics). */
			get capturing() {
				return this.active !== void 0;
			}
			onFrames(capture, chunk) {
				if (capture.finishing || this.active !== capture) return;
				const room = capture.maxFrames - capture.frames;
				const take = Math.min(room, chunk.length);
				if (take > 0) {
					const kept = take === chunk.length ? chunk : chunk.slice(0, take);
					capture.chunks.push(kept);
					capture.frames += take;
					let power = 0;
					for (let i = 0; i < kept.length; i++) power += kept[i] * kept[i];
					const rms = Math.sqrt(power / Math.max(1, kept.length));
					capture.level = Math.max(Math.min(1, rms * 4), capture.level * .8);
				}
				if (capture.frames >= capture.maxFrames && capture.session !== void 0) this.finish(capture, true);
			}
			async finish(capture, limitReached) {
				if (capture.finishing) return;
				capture.finishing = true;
				clearInterval(capture.meter);
				const sessionId = capture.sessionId;
				const state = this.state(sessionId);
				const opened = capture.session;
				this.active = void 0;
				state.phase = "encoding";
				this.publish(sessionId);
				await opened.close();
				if (capture.frames * 1e3 / opened.sampleRate < this.spec.minDurationMs) {
					capture.chunks.length = 0;
					this.fail(sessionId, "too-short", "");
					return;
				}
				try {
					const samples = joinChunks(capture.chunks, capture.frames);
					capture.chunks.length = 0;
					const rate = this.spec.targetSampleRate === 0 ? opened.sampleRate : this.spec.targetSampleRate;
					const wav = encodeWavPcm16(await resampleMonoAsync(samples, opened.sampleRate, rate), rate);
					const sha256 = await sha256Hex(wav.bytes);
					if (this.disposed || state.phase !== "encoding") return;
					const blob = new Blob([wav.bytes], { type: "audio/wav" });
					state.clip = {
						data: wav.bytes,
						url: URL.createObjectURL(blob),
						name: clipName(/* @__PURE__ */ new Date()),
						mimeType: "audio/wav",
						bytes: wav.bytes.byteLength,
						durationMs: wav.durationMs,
						sampleRate: wav.sampleRate,
						channels: 1,
						sha256,
						limitReached,
						deviceLabel: opened.deviceLabel
					};
					state.phase = "preview";
					this.publish(sessionId);
				} catch (error) {
					this.fail(sessionId, "encode-failed", error instanceof Error ? error.message : String(error));
				}
			}
			fail(sessionId, code, detail) {
				const state = this.state(sessionId);
				state.error = {
					code,
					detail
				};
				state.phase = state.clip === void 0 ? "error" : "preview";
				this.publish(sessionId);
			}
			releaseClip(state) {
				const clip = state.clip;
				state.clip = void 0;
				if (clip !== void 0) setTimeout(() => {
					URL.revokeObjectURL(clip.url);
				}, 0);
			}
			state(sessionId) {
				let state = this.states.get(sessionId);
				if (state === void 0) {
					state = {
						phase: "idle",
						clip: void 0,
						progress: void 0,
						error: void 0,
						lastSent: void 0,
						sendAbort: void 0,
						snapshot: void 0
					};
					this.states.set(sessionId, state);
				}
				return state;
			}
			snapshotOf(sessionId) {
				const state = this.state(sessionId);
				if (state.snapshot !== void 0) return state.snapshot;
				const capture = this.active?.sessionId === sessionId ? this.active : void 0;
				const recording = capture !== void 0 && state.phase === "recording";
				const sampleRate = capture?.session?.sampleRate ?? 0;
				const clip = state.clip === void 0 ? void 0 : withoutData(state.clip);
				state.snapshot = {
					phase: state.phase,
					supported: this.backend.support() === void 0,
					elapsedMs: recording && sampleRate > 0 ? Math.round(capture.frames * 1e3 / sampleRate) : 0,
					limitMs: this.spec.maxDurationMs,
					level: recording ? capture.level : 0,
					devices: this.devices,
					selectedDeviceId: this.selectedDeviceId,
					activeDeviceLabel: capture?.session?.deviceLabel ?? "",
					clip,
					progress: state.progress,
					error: state.error,
					lastSent: state.lastSent
				};
				return state.snapshot;
			}
			publish(sessionId) {
				const state = this.state(sessionId);
				state.snapshot = void 0;
				for (const listener of [...this.listeners]) listener();
			}
			publishAll() {
				for (const state of this.states.values()) state.snapshot = void 0;
				for (const listener of [...this.listeners]) listener();
			}
		};
		function withoutData(clip) {
			const { data: _data, ...rest } = clip;
			return rest;
		}
		function clipName(date) {
			const pad = (n) => String(n).padStart(2, "0");
			return `recording-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.wav`;
		}
		function safeLocalStorage() {
			try {
				return typeof localStorage === "undefined" ? void 0 : localStorage;
			} catch {
				return;
			}
		}
		function readPreference(storage) {
			try {
				return storage?.getItem(DEVICE_KEY) ?? "";
			} catch {
				return "";
			}
		}
		//#endregion
		//#region src/client/locale.ts
		/** `voiceCapture` namespace dictionaries (zh follows the shipped Simplified Chinese UI). */
		/** Dictionary namespace owned by this plugin. */
		const NS = "voiceCapture";
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"mic.start": "录音",
			"mic.stop": "停止录音",
			"mic.busy": "正在处理录音",
			"mic.pending": "有待发送的录音",
			"mic.unsupported": "当前页面无法使用麦克风",
			"mic.subagent": "子代理会话不支持录音",
			"panel.label": "录音面板",
			"status.requesting": "正在请求麦克风权限…",
			"status.recording": "正在录音",
			"status.encoding": "正在准备音频…",
			"status.preview": "录音预览",
			"status.uploading": "正在上传音频 {percent}%",
			"status.submitting": "正在发送…",
			"status.sent": "已发送录音 {name}",
			"status.limitReached": "已达到 {limit} 录音上限，录音已自动停止",
			"timer.label": "已录音 {elapsed}，上限 {limit}",
			"level.label": "输入音量",
			"device.label": "麦克风",
			"device.default": "系统默认麦克风",
			"device.unnamed": "麦克风 {index}",
			"device.recordingWith": "使用：{name}",
			"clip.player": "录音预览播放器",
			"clip.details": "{duration} · {size} · WAV {rate} kHz 单声道",
			"clip.withDraft": "将与输入框中的文字一起发送",
			"clip.withReferences": "输入框含引用内容，录音将单独发送，文字保留在输入框",
			"clip.audioOnly": "将以音频附件发送给当前选择的模型",
			"action.stop": "停止",
			"action.cancel": "取消",
			"action.discard": "丢弃",
			"action.rerecord": "重新录音",
			"action.send": "发送录音",
			"action.cancelSend": "取消发送",
			"action.dismiss": "关闭",
			"action.retry": "重试",
			"error.insecure-context": "麦克风只能在安全连接（HTTPS、localhost 或桌面应用）中使用。",
			"error.unsupported": "此浏览器或应用不支持麦克风录音。",
			"error.permission-denied": "麦克风权限被拒绝。请在浏览器网站设置或 macOS“系统设置 → 隐私与安全性 → 麦克风”中允许后重试。",
			"error.no-device": "找不到可用的麦克风。请连接麦克风或选择其他输入设备。",
			"error.device-busy": "麦克风正被其他应用占用或无法读取。",
			"error.capture-failed": "无法开始录音。",
			"error.busy-elsewhere": "另一个会话正在录音，请先停止该录音。",
			"error.too-short": "录音太短，请重新录音。",
			"error.encode-failed": "无法生成音频文件。",
			"error.upload-failed": "音频上传失败，录音已保留，可以重试。",
			"error.prompt-failed": "消息发送失败，录音已保留，可以重试。",
			"error.session-unavailable": "会话暂不可用，录音已保留。",
			"error.detail": "详情：{detail}",
			"reply.player": "回复音频播放器",
			"reply.label": "语音回复",
			"reply.download": "下载音频",
			"reply.downloading": "正在下载…",
			"reply.unavailable": "无法载入这段录音（音频插件可能已移除，或文件已删除）。",
			"reply.speakingStreaming": "正在播放语音回复（边收边播）",
			"reply.speakingFinal": "正在播放语音回复",
			"reply.receiving": "正在接收语音回复…",
			"reply.ended": "语音回复播放完毕",
			"reply.stopped": "已停止播放",
			"reply.finalOnly": "服务器在回复结束时才送出完整音频（非串流语音）",
			"reply.progressive": "已在回复结束前开始播放（{chunks} 段）",
			"reply.gaps": "有 {gaps} 处音频遗失，已以静音补上",
			"reply.stop": "停止播放",
			"reply.autoplay": "自动朗读回复",
			"reply.generated.label": "生成音频播放",
			"reply.generated.receiving": "正在接收生成的音频…",
			"reply.generated.playingStreaming": "正在播放生成的音频（边收边播）",
			"reply.generated.playing": "正在播放生成的音频",
			"reply.generated.ended": "生成的音频播放完毕",
			"reply.generated.finalOnly": "服务器在生成结束时才送出完整音频（非串流）",
			"reply.generated.autoplay": "自动播放生成的音频",
			"live.start": "实时对话",
			"live.startTitle": "实时对话：录音时即传送给模型（{evidence}）",
			"live.panel": "实时对话面板",
			"live.opening": "正在建立实时会话…",
			"live.sending": "实时传送中",
			"live.awaiting": "已结束输入，等待回复…",
			"live.closing": "正在结束实时会话…",
			"live.closed": "实时会话已结束",
			"live.logging": "正在把这段实时对话记录到会话…",
			"live.logged": "已记录到会话",
			"live.logFailed": "实时对话未能记录到会话：{detail}",
			"live.stats": "已送出 {sent} 段 · 服务器确认 {accepted} 段",
			"live.acceptedEarly": "录音进行中已被接收 {count} 段",
			"live.endInput": "结束输入",
			"live.cancelResponse": "取消回复",
			"live.bargeIn": "插话",
			"live.close": "结束实时对话",
			"live.dismiss": "关闭",
			"live.transcript": "回复文字",
			"live.error": "实时对话出错：{detail}",
			"live.micBusy": "麦克风正在录音，请先停止录音。",
			"live.reconnecting": "服务器连接中断，正在重连；音频暂存等待恢复…",
			"live.resumed": "连接已恢复（第 {count} 次重连）",
			"live.ended.IDLE_TIMEOUT": "15 秒内没有音频或操作，实时会话已由服务器结束。",
			"live.ended.RESYNC_REQUIRED": "服务器要求重新同步，无法恢复原会话；请重新开始实时对话。",
			"live.ended.RESUME_REJECTED": "服务器拒绝恢复会话；请重新开始实时对话。",
			"live.ended.BACKEND_DISCONNECTED": "与模型服务器的连接已中断且未能恢复。",
			"live.ended.other": "实时会话已结束：{detail}",
			"evidence.verified": "已在本机验证",
			"evidence.advertised": "服务器声明支持，尚未测试",
			"evidence.declared": "配置声明支持，尚未验证",
			"evidence.untested": "实验功能，尚未验证",
			"evidence.unsupported": "不支持",
			"task.name.chat": "文字对话",
			"task.name.audio-chat": "音频理解问答",
			"task.name.omni-chat": "语音对话（文字+语音回复）",
			"task.name.asr": "语音转文字",
			"task.name.translation": "语音翻译成文字",
			"task.name.diarization": "说话人分离转写",
			"task.name.tts": "文字转语音",
			"task.name.voice-clone": "参考音色合成",
			"task.name.s2s": "语音转语音",
			"task.name.realtime-asr": "实时转写",
			"task.name.duplex": "全双工实时对话",
			"task.name.music-generation": "音乐生成",
			"task.name.sound-generation": "音效生成",
			"task.name.audio-edit": "音频编辑",
			"task.name.enhancement": "音频增强",
			"task.name.separation": "音轨分离",
			"task.name.audio-embedding": "音频向量",
			"task.panel": "音频任务",
			"task.inferred": "（依模型设定推断）",
			"task.optional": "可选",
			"task.output.text": "输出：文字回答",
			"task.output.transcript": "输出：文字转写（含时间轴）",
			"task.output.speakers": "输出：带说话人的转写",
			"task.output.spoken": "输出：文字与语音回复",
			"task.output.audio": "输出：生成的音频文件（不是对话语音）",
			"task.output.audioMany": "输出：多个音频文件（音轨）",
			"task.output.embedding": "输出：音频向量（JSON）",
			"task.needs": "还需要：{items}",
			"task.missing.text": "在输入框输入文字",
			"task.missing.textTooLong": "文字超过长度上限",
			"task.missing.audio": "录音或音频文件",
			"task.missing.referenceAudio": "参考音色",
			"task.missing.referenceConsent": "确认你有权使用此音色",
			"task.missing.referenceText": "参考音频的文字内容",
			"task.readyText": "将使用输入框文字与以上设置生成",
			"task.hint.audioRequired": "用麦克风录音或附加音频文件后发送",
			"task.hint.audioOptional": "可输入文字，也可附加录音或音频",
			"task.hint.text": "在输入框输入后发送",
			"task.hint.liveTranscription": "使用「实时转写」一边说话一边出文字；此模型不会以语音回复",
			"task.hint.liveTurn": "使用「语音轮次」：说完一段后模型用语音回复，不能边说边插话",
			"task.hint.textInput": "使用「流式朗读」分段送出文字，边生成边播放",
			"task.hint.liveConversation": "使用「实时对话」进行语音对话",
			"task.action.generateSpeech": "生成语音",
			"task.action.generateAudio": "生成音频",
			"task.error.upload-failed": "参考音频上传失败",
			"task.error.prompt-failed": "请求发送失败",
			"task.error.session-unavailable": "会话暂不可用",
			"task.error.reference-too-large": "参考音频超过 20 MB",
			"task.error.reference-type": "不支持的参考音频格式",
			"reference.titleRequired": "参考音色（必需）",
			"reference.titleOptional": "参考音色（可选）",
			"reference.record": "录制参考音色",
			"reference.chooseFile": "选择音频文件",
			"reference.previewRecorded": "刚录制的参考音色",
			"reference.use": "使用这段参考",
			"reference.player": "参考音色播放器",
			"reference.clear": "移除参考音色",
			"reference.consent": "我有权使用这个声音（本人或已获授权）",
			"reference.textLabel": "参考音频文字",
			"reference.textRequired": "参考音频中说的内容（必需）",
			"reference.textOptional": "参考音频中说的内容（可选）",
			"gate.cold": "模型未启动，请在模型库中启动",
			"gate.queued": "模型排队启动中",
			"gate.stopping": "正在停止先前的模型",
			"gate.loading": "模型载入中",
			"gate.busy": "服务器忙碌中",
			"gate.error": "模型启动失败",
			"gate.ready": "就绪",
			"gate.static": "固定端点",
			"gate.unknown": "状态未知",
			"result.transcript": "转写结果",
			"result.translation": "翻译结果",
			"result.speakers": "说话人转写",
			"result.copy": "复制",
			"result.copied": "已复制",
			"result.speechReply": "语音回复",
			"result.generatedSpeech": "生成的语音",
			"result.generatedMusic": "生成的音乐",
			"result.generatedSound": "生成的音效",
			"result.enhancedAudio": "增强后的音频",
			"result.editedAudio": "编辑后的音频",
			"result.stem": "分离音轨：{name}",
			"result.audio": "音频结果",
			"result.embedding": "音频向量",
			"result.dims": "{dims} 维",
			"result.downloadJson": "下载 JSON",
			"result.loading": "正在载入结果…",
			"result.unavailable": "无法载入这个结果（插件可能已移除或结果已删除）",
			"reply.audioOutput": "音频输出",
			"reply.unavailableShort": "无法下载",
			"live.startTranscribe": "实时转写",
			"live.startTranscribeTitle": "实时转写：一边说话一边出文字，不会语音回复（{evidence}）",
			"live.panelTranscription": "实时转写面板",
			"live.transcribing": "实时转写中",
			"live.transcriptTitle": "转写文字",
			"live.gated": "模型尚未就绪：{reason}",
			"error.model-not-ready": "所选模型尚未就绪，录音已保留；模型就绪后可以重试。",
			"task.error.model-not-ready": "所选模型尚未就绪，请求未送出",
			"gate.activating": "模型启动中",
			"gate.unloading": "模型正在卸载",
			"gate.failed": "模型启动失败",
			"gate.openLibrary": "打开模型库",
			"gate.sourceLibrary": "状态来自模型库",
			"gate.sourceAdapter": "状态来自音频适配器",
			"task.name.tts-stream": "流式文字转语音",
			"live.startTurn": "语音轮次",
			"live.startTurnTitle": "实时语音轮次：说完一段后模型用语音回复，不是全双工（{evidence}）",
			"live.panelTurn": "实时语音轮次面板",
			"live.startSpeak": "流式朗读",
			"live.startSpeakTitle": "流式文字转语音：分段送出文字，边生成边播放（{evidence}）",
			"live.panelTextInput": "流式文字转语音面板",
			"live.textPlaceholder": "输入要朗读的文字",
			"live.sendText": "送出文字",
			"live.finishText": "文字结束",
			"live.textStats": "已送出 {count} 段文字",
			"live.textLive": "流式朗读中",
			"live.chooseTitle": "选择实时模式",
			"live.kind.transcription": "实时转写（无语音回复）",
			"live.kind.conversation": "全双工实时对话",
			"live.kind.turn": "语音轮次（非全双工）",
			"live.kind.text-input": "流式文字转语音",
			"live.notReady": "模型尚未就绪，请先在模型库中启动",
			"live.notLogged": "此模式的交换不会记录到会话中",
			"params.applying": "正在套用参数…",
			"params.applied": "参数已套用到此会话",
			"params.failed": "参数未套用：{detail}",
			"params.unsupported": "此音频插件版本不支持会话参数，参数只随“生成”请求送出",
			"param.valuesLoading": "正在载入可选值…",
			"param.valuesUnavailable": "无法载入可选值，可以直接输入",
			"param.listHint": "多个值用逗号分隔",
			"live.rejectedFrames": "服务器拒收 {count} 段",
			"live.integrity": "实际送达 {delivered} 段（转发 {forwarded}，服务器拒收 {rejected}）",
			"live.textParamsApplied": "已套用到本段文字：{keys}",
			"live.textParamsInUtterance": "请先结束当前这段文字，再更改选项",
			"live.textParamsRejected": "选项未套用：{detail}",
			"live.words.silence": "（静音，无逐词时间戳）",
			"live.words.failed": "（逐词对齐失败）",
			"live.endUtterance": "结束这段文字",
			"live.control.pending": "{action}已送出，等待服务器结果…",
			"live.control.nothing": "没有可{action}的回复",
			"live.control.notActive": "该回复已不是进行中的回复",
			"live.control.alreadyFinished": "回复已经结束，无需{action}",
			"live.control.unconfirmed": "{action}未获服务器确认",
			"live.control.cancelledPending": "服务器已接受{action}，等待回复停止",
			"live.control.done": "已{action}：服务器确认回复已停止",
			"live.control.noOutcome": "{action}已送出（此服务器版本不回报结果）",
			"live.control.failed": "{action}失败：{detail}",
			"result.video.title": "生成的视频",
			"result.video.track": "音轨：{details}",
			"result.video.noTrack": "这个视频没有音轨",
			"result.video.trackUnknown": "音轨信息未提供",
			"task.videoProgress": "视频生成中：{status}{progress}",
			"task.name.video-generation": "视频生成（含音轨）",
			"task.name.alignment": "强制对齐（逐词时间戳）",
			"task.missing.imageReference": "参考图片",
			"task.missing.audioReference": "参考音频",
			"task.missing.requiredOption": "必填选项：{keys}",
			"reference.slot.imageReference": "参考图片",
			"reference.slot.audioReference": "参考音频（视频音轨）",
			"task.hint.alignment": "录音或附加音频，并在输入框输入这段音频的文字",
			"task.action.generateVideo": "生成视频",
			"task.output.video": "输出：视频文件（音轨依服务器结果）",
			"option.required": "必填",
			"option.requiredWhen": "条件必填：{raw}",
			"option.unverified": "来源列出，此模型尚未验证",
			"option.restricted": "来源列出但有限制：{raw}",
			"option.configured": "由部署配置设定（目录支持未知）",
			"option.server": "选项由服务器提供（目录支持未知）",
			"option.notOffered": "未提供 {count} 个选项",
			"option.reason.rejected": "服务器拒绝",
			"option.reason.rejected-conditional": "服务器拒绝部分取值",
			"option.reason.unsupported": "来源标明不支持",
			"option.reason.not-forwarded": "接受但未转发给模型",
			"option.reason.ignored": "接受但无效果",
			"option.reason.conflict": "来源互相矛盾（需目录更正）",
			"option.unlisted": "此变体未列出 {count} 个选项（不代表不支持）",
			"option.unknown": "此模型的选项支持未知（不代表不支持）",
			"option.unknownKeys": "未知：{keys}",
			"option.scope": "范围：{scope}",
			"option.notes": "目录说明：{notes}",
			"option.blocker": "此变体需要 {option}，但此主机配置无法发送（{reason}）",
			"option.notSendable": "此连线无法发送：{options}",
			"option.inputErrors": "主机丢弃了目录字段：{fields}",
			"option.source.option-controls": "选项来自模型目录，经此主机提供（此模型尚未验证）",
			"option.source.none": "此主机未提供选项控制：目录选项未知",
			"option.basis.catalog-map-empty": "目录未列出此变体的选项",
			"param.hidden": "未显示 {count} 个选项：此模型没有列出支持（{keys}）",
			"param.support.listed": "模型目录列出此模型支持这个选项",
			"param.support.configured": "由部署配置设定",
			"param.support.server": "选项由服务器提供",
			"param.objectHint": "JSON 对象，例如 {\"key\": \"value\"}",
			"param.label.speed": "语速",
			"param.label.sampleRate": "采样率",
			"param.label.wordTimestamps": "逐词时间戳",
			"param.label.xVectorOnlyMode": "仅用声纹（不需参考文字）",
			"param.label.nonStreamingMode": "非流式生成",
			"param.label.initialCodecChunkFrames": "首段编码帧数",
			"param.label.ambientSound": "环境音描述",
			"param.label.durationSeconds": "时长（秒）",
			"param.label.extraParams": "模型额外参数",
			"task.liveOptions": "实时选项 · {model}",
			"reference.slot.referenceAudio2": "第二位说话人参考音频",
			"reference.slot.emotionAudio": "情绪参考音频",
			"reference.required": "必填",
			"task.missing.referenceAudio2": "第二位说话人参考音频",
			"task.missing.emotionAudio": "情绪参考音频",
			"result.wordTimestamps": "逐词时间戳",
			"result.wordCount": "{count} 个词",
			"result.words.omitted": "服务器未提供时间戳（部署未启用对齐）",
			"result.words.missing": "回复中没有时间戳",
			"result.words.invalid": "时间戳格式无效",
			"live.input.verified": "输入已送达（本机收到服务器确认）",
			"live.input.advertised": "服务器声明可接收串流输入，尚未确认送达",
			"live.input.declared": "配置声明可接收串流输入，尚未确认送达",
			"live.input.untested": "串流输入尚未声明或测试",
			"live.input.unsupported": "不支持串流输入",
			"live.duplex.native": "服务器报告原生全双工（{level}）；对话效果尚未验证",
			"live.duplex.fallback": "服务器退回非原生模式（{level}）：模型不会边听边接话，结束输入后才可能回复",
			"live.duplex.unknown": "服务器没有报告全双工能力；输入送达不代表全双工对话可用",
			"result.deliveryProgressive": "串流送达",
			"result.deliveryFinal": "完成后一次送达",
			"param.label.voice": "声音",
			"param.label.instructions": "风格说明",
			"param.label.language": "语言",
			"param.label.taskType": "合成类型",
			"param.label.responseFormat": "输出格式",
			"param.label.maxNewTokens": "最大生成长度",
			"param.label.refText": "参考文字",
			"param.label.audioLength": "时长（秒）",
			"param.label.negativePrompt": "不要出现",
			"param.label.guidanceScale": "引导强度",
			"param.label.numInferenceSteps": "推理步数",
			"param.label.seed": "随机种子",
			"param.label.prompt": "提示文字",
			"param.label.timestampGranularities": "时间戳粒度",
			"param.label.toLanguage": "目标语言",
			"param.label.overlapPolicy": "重叠说话策略",
			"param.label.turnDetection": "轮次检测",
			"gate.live-only": "此模型只能用实时模式；文字或录音消息会失败，请改用输入框旁的实时按钮",
			"live.speakNow": "已连接，可以说话",
			"live.buffering": "正在连接模型，已缓冲 {seconds} 秒音频（上限 {max} 秒）",
			"live.buffered": "待送出 {seconds} 秒（上限 {max} 秒）",
			"live.waitingFor": "已等待 {seconds} 秒",
			"live.noReplyYet": "已等待 {seconds} 秒仍没有回复；可以继续等待或结束实时会话",
			"live.serverBusy": "模型服务器仍在处理其他请求（{detail}），请等待回复结束或停止回复后再开启",
			"live.openRejected": "模型服务器没有建立实时会话；若同一服务器仍在回复其他请求，请等待完成后再试",
			"live.logUnavailableNoReply": "服务器没有产生回复或转写，所以这次实时交换没有记录到会话中",
			"live.logUnavailableNoInput": "没有可记录的输入，这次实时交换没有记录到会话中",
			"live.replyRunning": "此会话仍在回复，请等待或停止回复后再开启实时模式",
			"live.unavailable.untested": "{model}：实时输入尚未声明或测试，因此不能开启（请在设置或模型库声明或测试）",
			"live.unavailable.unsupported": "{model}：音频适配器报告不支持实时输入{detail}"
		};
		/** English dictionary with the same key set. */
		const en = {
			"mic.start": "Record audio",
			"mic.stop": "Stop recording",
			"mic.busy": "Processing recording",
			"mic.pending": "Recording ready to send",
			"mic.unsupported": "Microphone is not available on this page",
			"mic.subagent": "Recording is not available in subagent sessions",
			"panel.label": "Recording panel",
			"status.requesting": "Requesting microphone permission…",
			"status.recording": "Recording",
			"status.encoding": "Preparing audio…",
			"status.preview": "Recording preview",
			"status.uploading": "Uploading audio {percent}%",
			"status.submitting": "Sending…",
			"status.sent": "Sent recording {name}",
			"status.limitReached": "Reached the {limit} limit; recording stopped automatically",
			"timer.label": "Recorded {elapsed} of {limit}",
			"level.label": "Input level",
			"device.label": "Microphone",
			"device.default": "System default microphone",
			"device.unnamed": "Microphone {index}",
			"device.recordingWith": "Using: {name}",
			"clip.player": "Recording preview player",
			"clip.details": "{duration} · {size} · WAV {rate} kHz mono",
			"clip.withDraft": "Will be sent together with the text in the message box",
			"clip.withReferences": "The message box contains references; the recording is sent alone and the text stays",
			"clip.audioOnly": "Sent as an audio attachment to the selected model",
			"action.stop": "Stop",
			"action.cancel": "Cancel",
			"action.discard": "Discard",
			"action.rerecord": "Record again",
			"action.send": "Send recording",
			"action.cancelSend": "Cancel sending",
			"action.dismiss": "Dismiss",
			"action.retry": "Try again",
			"error.insecure-context": "The microphone only works over a secure connection (HTTPS, localhost, or the desktop app).",
			"error.unsupported": "This browser or app does not support microphone recording.",
			"error.permission-denied": "Microphone access was denied. Allow it in the browser site settings or in macOS System Settings → Privacy & Security → Microphone, then try again.",
			"error.no-device": "No microphone was found. Connect one or choose another input.",
			"error.device-busy": "The microphone is in use by another app or cannot be read.",
			"error.capture-failed": "Recording could not start.",
			"error.busy-elsewhere": "Another session is recording. Stop that recording first.",
			"error.too-short": "The recording is too short. Record again.",
			"error.encode-failed": "The audio file could not be created.",
			"error.upload-failed": "Uploading the audio failed. The recording is kept so you can retry.",
			"error.prompt-failed": "Sending the message failed. The recording is kept so you can retry.",
			"error.session-unavailable": "The session is not available right now. The recording is kept.",
			"error.detail": "Details: {detail}",
			"reply.player": "Reply audio player",
			"reply.label": "Spoken reply",
			"reply.download": "Download audio",
			"reply.downloading": "Downloading…",
			"reply.unavailable": "This recording cannot be loaded (the audio plugin may be removed or the file deleted).",
			"reply.speakingStreaming": "Playing spoken reply (streaming)",
			"reply.speakingFinal": "Playing spoken reply",
			"reply.receiving": "Receiving spoken reply…",
			"reply.ended": "Spoken reply finished",
			"reply.stopped": "Playback stopped",
			"reply.finalOnly": "The server sent the complete audio at the end of the reply (not streaming speech)",
			"reply.progressive": "Playback started before the reply finished ({chunks} chunks)",
			"reply.gaps": "{gaps} audio gaps were filled with silence",
			"reply.stop": "Stop playback",
			"reply.autoplay": "Read replies aloud",
			"reply.generated.label": "Generated audio playback",
			"reply.generated.receiving": "Receiving generated audio…",
			"reply.generated.playingStreaming": "Playing generated audio (streaming)",
			"reply.generated.playing": "Playing generated audio",
			"reply.generated.ended": "Generated audio finished",
			"reply.generated.finalOnly": "The server sent the complete audio when generation finished (not streamed)",
			"reply.generated.autoplay": "Play generated audio automatically",
			"live.start": "Live",
			"live.startTitle": "Live conversation: audio is sent to the model while you speak ({evidence})",
			"live.panel": "Live conversation panel",
			"live.opening": "Opening live session…",
			"live.sending": "Live — sending audio",
			"live.awaiting": "Input ended, waiting for the reply…",
			"live.closing": "Ending live session…",
			"live.closed": "Live session ended",
			"live.logging": "Recording this live exchange in the conversation…",
			"live.logged": "Recorded in the conversation",
			"live.logFailed": "The live exchange was not recorded in the conversation: {detail}",
			"live.stats": "{sent} frames sent · {accepted} acknowledged by the server",
			"live.acceptedEarly": "{count} frames accepted while recording",
			"live.endInput": "End input",
			"live.cancelResponse": "Cancel reply",
			"live.bargeIn": "Interrupt",
			"live.close": "End live session",
			"live.dismiss": "Close",
			"live.transcript": "Reply text",
			"live.error": "Live conversation error: {detail}",
			"live.micBusy": "The microphone is recording. Stop that recording first.",
			"live.reconnecting": "Server connection interrupted; reconnecting and holding audio until it recovers…",
			"live.resumed": "Connection restored ({count} reconnect(s))",
			"live.ended.IDLE_TIMEOUT": "The server ended the live session after 15 s without audio or controls.",
			"live.ended.RESYNC_REQUIRED": "The server required a resync and could not resume this session. Start a new live session.",
			"live.ended.RESUME_REJECTED": "The server rejected resuming this session. Start a new live session.",
			"live.ended.BACKEND_DISCONNECTED": "The connection to the model server was lost and could not be restored.",
			"live.ended.other": "Live session ended: {detail}",
			"evidence.verified": "verified on this host",
			"evidence.advertised": "server-advertised, not yet tested",
			"evidence.declared": "declared by configuration, not verified",
			"evidence.untested": "experimental, not verified",
			"evidence.unsupported": "not supported",
			"task.name.chat": "Text chat",
			"task.name.audio-chat": "Audio understanding",
			"task.name.omni-chat": "Voice chat (text + speech reply)",
			"task.name.asr": "Speech to text",
			"task.name.translation": "Speech translation to text",
			"task.name.diarization": "Transcription with speakers",
			"task.name.tts": "Text to speech",
			"task.name.voice-clone": "Voice cloning TTS",
			"task.name.s2s": "Speech to speech",
			"task.name.realtime-asr": "Realtime transcription",
			"task.name.duplex": "Full-duplex live conversation",
			"task.name.music-generation": "Music generation",
			"task.name.sound-generation": "Sound generation",
			"task.name.audio-edit": "Audio editing",
			"task.name.enhancement": "Audio enhancement",
			"task.name.separation": "Source separation",
			"task.name.audio-embedding": "Audio embedding",
			"task.panel": "Audio task",
			"task.inferred": "(inferred from model settings)",
			"task.optional": "optional",
			"task.output.text": "Output: text answer",
			"task.output.transcript": "Output: text transcript with timestamps",
			"task.output.speakers": "Output: transcript with speakers",
			"task.output.spoken": "Output: text and spoken reply",
			"task.output.audio": "Output: generated audio file (not a spoken conversation)",
			"task.output.audioMany": "Output: several audio files (stems)",
			"task.output.embedding": "Output: audio embedding (JSON)",
			"task.needs": "Still needed: {items}",
			"task.missing.text": "text in the message box",
			"task.missing.textTooLong": "shorter text",
			"task.missing.audio": "a recording or audio file",
			"task.missing.referenceAudio": "a reference voice clip",
			"task.missing.referenceConsent": "confirmation that you may use this voice",
			"task.missing.referenceText": "the reference clip transcript",
			"task.readyText": "Uses the message box text and the settings above",
			"task.hint.audioRequired": "Record with the microphone or attach an audio file, then send",
			"task.hint.audioOptional": "Type text, and optionally add a recording or audio file",
			"task.hint.text": "Type in the message box and send",
			"task.hint.liveTranscription": "Use Live transcribe to see text while you speak; this model does not answer with speech",
			"task.hint.liveTurn": "Use Voice turns: after each spoken turn the model replies with speech; you cannot interrupt while it speaks",
			"task.hint.textInput": "Use Stream speech to send text in pieces and hear it as it is generated",
			"task.hint.liveConversation": "Use Live for a spoken conversation",
			"task.action.generateSpeech": "Generate speech",
			"task.action.generateAudio": "Generate audio",
			"task.error.upload-failed": "Uploading the reference clip failed",
			"task.error.prompt-failed": "Sending the request failed",
			"task.error.session-unavailable": "The session is not available",
			"task.error.reference-too-large": "The reference clip is larger than 20 MB",
			"task.error.reference-type": "Unsupported reference audio format",
			"reference.titleRequired": "Reference voice (required)",
			"reference.titleOptional": "Reference voice (optional)",
			"reference.record": "Record reference",
			"reference.chooseFile": "Choose audio file",
			"reference.previewRecorded": "Recorded reference preview",
			"reference.use": "Use as reference",
			"reference.player": "Reference voice player",
			"reference.clear": "Remove reference voice",
			"reference.consent": "I have the right to use this voice (my own or authorized)",
			"reference.textLabel": "Reference transcript",
			"reference.textRequired": "What the reference clip says (required)",
			"reference.textOptional": "What the reference clip says (optional)",
			"gate.cold": "Model is not running; start it in the model library",
			"gate.queued": "Model start is queued",
			"gate.stopping": "Stopping the previous model",
			"gate.loading": "Model is loading",
			"gate.busy": "Server is busy",
			"gate.error": "Model activation failed",
			"gate.ready": "Ready",
			"gate.static": "Static endpoint",
			"gate.unknown": "Status unknown",
			"result.transcript": "Transcript",
			"result.translation": "Translation",
			"result.speakers": "Transcript by speaker",
			"result.copy": "Copy",
			"result.copied": "Copied",
			"result.speechReply": "Spoken reply",
			"result.generatedSpeech": "Generated speech",
			"result.generatedMusic": "Generated music",
			"result.generatedSound": "Generated sound",
			"result.enhancedAudio": "Enhanced audio",
			"result.editedAudio": "Edited audio",
			"result.stem": "Separated stem: {name}",
			"result.audio": "Audio result",
			"result.embedding": "Audio embedding",
			"result.dims": "{dims} dimensions",
			"result.downloadJson": "Download JSON",
			"result.loading": "Loading result…",
			"result.unavailable": "This result cannot be loaded (the plugin may be removed or the result deleted)",
			"reply.audioOutput": "Audio output",
			"reply.unavailableShort": "Unavailable",
			"live.startTranscribe": "Live transcribe",
			"live.startTranscribeTitle": "Live transcription: text appears while you speak; no spoken reply ({evidence})",
			"live.panelTranscription": "Live transcription panel",
			"live.transcribing": "Live — transcribing",
			"live.transcriptTitle": "Transcript",
			"live.gated": "Model not ready: {reason}",
			"error.model-not-ready": "The selected model is not ready. The recording is kept; try again when the model is ready.",
			"task.error.model-not-ready": "The selected model is not ready; the request was not sent",
			"gate.activating": "Model is starting",
			"gate.unloading": "Model is unloading",
			"gate.failed": "Model activation failed",
			"gate.openLibrary": "Open model library",
			"gate.sourceLibrary": "State reported by the model library",
			"gate.sourceAdapter": "State reported by the audio adapter",
			"task.name.tts-stream": "Streaming text to speech",
			"live.startTurn": "Voice turns",
			"live.startTurnTitle": "Live voice turns: after each spoken turn the model replies with speech; not full duplex ({evidence})",
			"live.panelTurn": "Live voice turns panel",
			"live.startSpeak": "Stream speech",
			"live.startSpeakTitle": "Streaming text to speech: send text in pieces and hear it as it is generated ({evidence})",
			"live.panelTextInput": "Streaming text to speech panel",
			"live.textPlaceholder": "Text to speak",
			"live.sendText": "Send text",
			"live.finishText": "End text",
			"live.textStats": "{count} text pieces sent",
			"live.textLive": "Streaming speech",
			"live.chooseTitle": "Choose a live mode",
			"live.kind.transcription": "Live transcription (no spoken reply)",
			"live.kind.conversation": "Full-duplex live conversation",
			"live.kind.turn": "Voice turns (not full duplex)",
			"live.kind.text-input": "Streaming text to speech",
			"live.notReady": "The model is not ready; start it in the model library first",
			"live.notLogged": "This mode does not record the exchange in the conversation",
			"params.applying": "Applying parameters…",
			"params.applied": "Parameters applied to this conversation",
			"params.failed": "Parameters not applied: {detail}",
			"params.unsupported": "This audio plugin version has no session parameters; they are sent only with Generate",
			"param.valuesLoading": "Loading choices…",
			"param.valuesUnavailable": "Choices could not be loaded; you can type a value",
			"param.listHint": "Separate values with commas",
			"live.rejectedFrames": "{count} rejected by the server",
			"live.integrity": "{delivered} frames delivered ({forwarded} forwarded, {rejected} rejected by the server)",
			"live.textParamsApplied": "Applied to this text: {keys}",
			"live.textParamsInUtterance": "End the current text before changing options",
			"live.textParamsRejected": "Options not applied: {detail}",
			"live.words.silence": "(silence, no word timestamps)",
			"live.words.failed": "(word alignment failed)",
			"live.endUtterance": "End this text",
			"live.control.pending": "{action} sent, waiting for the server…",
			"live.control.nothing": "Nothing to {action}: no reply is active",
			"live.control.notActive": "That reply is no longer active",
			"live.control.alreadyFinished": "The reply had already finished",
			"live.control.unconfirmed": "{action} not confirmed by the server",
			"live.control.cancelledPending": "Server accepted {action}; waiting for the reply to stop",
			"live.control.done": "{action}: the server confirmed the reply stopped",
			"live.control.noOutcome": "{action} sent (this server version reports no outcome)",
			"live.control.failed": "{action} failed: {detail}",
			"result.video.title": "Generated video",
			"result.video.track": "Sound track: {details}",
			"result.video.noTrack": "This video has no sound track",
			"result.video.trackUnknown": "Sound track facts not reported",
			"task.videoProgress": "Generating video: {status}{progress}",
			"task.name.video-generation": "Video generation (with sound track)",
			"task.name.alignment": "Forced alignment (word timestamps)",
			"task.missing.imageReference": "reference image",
			"task.missing.audioReference": "reference audio",
			"task.missing.requiredOption": "required options: {keys}",
			"reference.slot.imageReference": "Reference image",
			"reference.slot.audioReference": "Reference audio (video sound track)",
			"task.hint.alignment": "Record or attach the audio and type its transcript in the message box",
			"task.action.generateVideo": "Generate video",
			"task.output.video": "Output: video file (sound track as reported by the server)",
			"option.required": "required",
			"option.requiredWhen": "required when: {raw}",
			"option.unverified": "listed by source, not verified for this model",
			"option.restricted": "listed with a restriction: {raw}",
			"option.configured": "set by the deployment configuration (catalog support unknown)",
			"option.server": "choices reported by the server (catalog support unknown)",
			"option.notOffered": "{count} options not offered",
			"option.reason.rejected": "rejected by the server",
			"option.reason.rejected-conditional": "the server rejects some values",
			"option.reason.unsupported": "not supported according to the source",
			"option.reason.not-forwarded": "accepted but not forwarded to the model",
			"option.reason.ignored": "accepted without effect",
			"option.reason.conflict": "the sources disagree (needs a catalog correction)",
			"option.unlisted": "{count} options not listed for this variant (not the same as unsupported)",
			"option.unknown": "Option support for this model is unknown (not the same as unsupported)",
			"option.unknownKeys": "unknown: {keys}",
			"option.scope": "scope: {scope}",
			"option.notes": "catalog notes: {notes}",
			"option.blocker": "This variant needs {option}, which this host configuration cannot send ({reason})",
			"option.notSendable": "not sendable on this connection: {options}",
			"option.inputErrors": "The host dropped catalog fields: {fields}",
			"option.source.option-controls": "Options from the model catalog through this host (not verified for this model)",
			"option.source.none": "This host publishes no option controls: catalog options unknown",
			"option.basis.catalog-map-empty": "the catalog lists no options for this variant",
			"param.hidden": "{count} options not shown: this model does not list them ({keys})",
			"param.support.listed": "Listed for this model by the catalog",
			"param.support.configured": "Set by the deployment configuration",
			"param.support.server": "Choices reported by the server",
			"param.objectHint": "JSON object, e.g. {\"key\": \"value\"}",
			"param.label.speed": "Speed",
			"param.label.sampleRate": "Sample rate",
			"param.label.wordTimestamps": "Word timestamps",
			"param.label.xVectorOnlyMode": "Speaker embedding only (no reference text)",
			"param.label.nonStreamingMode": "Non-streaming generation",
			"param.label.initialCodecChunkFrames": "First chunk codec frames",
			"param.label.ambientSound": "Ambient sound description",
			"param.label.durationSeconds": "Duration (s)",
			"param.label.extraParams": "Extra model parameters",
			"task.liveOptions": "Live options · {model}",
			"reference.slot.referenceAudio2": "Second speaker reference",
			"reference.slot.emotionAudio": "Emotion reference",
			"reference.required": "required",
			"task.missing.referenceAudio2": "second speaker reference",
			"task.missing.emotionAudio": "emotion reference",
			"result.wordTimestamps": "Word timestamps",
			"result.wordCount": "{count} words",
			"result.words.omitted": "The server omitted timestamps (alignment not enabled on the deployment)",
			"result.words.missing": "No timestamps in the response",
			"result.words.invalid": "Timestamps were malformed",
			"live.input.verified": "input delivered (server acknowledgements received on this host)",
			"live.input.advertised": "server says it accepts streamed input; delivery not yet confirmed",
			"live.input.declared": "configuration declares streamed input; delivery not yet confirmed",
			"live.input.untested": "streamed input not declared or tested",
			"live.input.unsupported": "streamed input not supported",
			"live.duplex.native": "server reports native full duplex ({level}); conversation quality not verified",
			"live.duplex.fallback": "server fell back to a non-native mode ({level}): the model will not answer while you speak; a reply may come only after you end input",
			"live.duplex.unknown": "the server did not report full-duplex support; delivered input does not mean duplex conversation works",
			"result.deliveryProgressive": "streamed",
			"result.deliveryFinal": "delivered complete",
			"param.label.voice": "Voice",
			"param.label.instructions": "Style instructions",
			"param.label.language": "Language",
			"param.label.taskType": "Synthesis type",
			"param.label.responseFormat": "Output format",
			"param.label.maxNewTokens": "Max new tokens",
			"param.label.refText": "Reference text",
			"param.label.audioLength": "Length (s)",
			"param.label.negativePrompt": "Avoid",
			"param.label.guidanceScale": "Guidance scale",
			"param.label.numInferenceSteps": "Inference steps",
			"param.label.seed": "Seed",
			"param.label.prompt": "Prompt",
			"param.label.timestampGranularities": "Timestamp granularity",
			"param.label.toLanguage": "Target language",
			"param.label.overlapPolicy": "Overlap policy",
			"param.label.turnDetection": "Turn detection",
			"gate.live-only": "This model only works in Live mode; typed or recorded messages to it fail. Use the Live button next to the composer",
			"live.speakNow": "Connected — speak now",
			"live.buffering": "Connecting to the model; {seconds} s of audio buffered (limit {max} s)",
			"live.buffered": "{seconds} s waiting to send (limit {max} s)",
			"live.waitingFor": "Waiting {seconds} s",
			"live.noReplyYet": "No reply after {seconds} s; keep waiting or end the live session",
			"live.serverBusy": "The model server is still handling another request ({detail}); wait for it to finish or stop the reply, then start Live",
			"live.openRejected": "The model server did not start the live session. If the same server is still answering another request, wait for it to finish and try again",
			"live.logUnavailableNoReply": "The server produced no reply or transcript, so this live exchange was not recorded in the conversation",
			"live.logUnavailableNoInput": "There was no input to record, so this live exchange was not recorded in the conversation",
			"live.replyRunning": "This conversation is still answering; wait or stop the reply before starting Live",
			"live.unavailable.untested": "{model}: live input is not declared or tested, so Live cannot start (declare or test it in settings or the model library)",
			"live.unavailable.unsupported": "{model}: the audio adapter reports live input as unsupported{detail}"
		};
		//#endregion
		//#region src/client/format.ts
		/**
		* Clock text for a duration.
		* @param ms - milliseconds.
		* @returns `m:ss` (or `h:mm:ss` past one hour).
		*/
		function clockText(ms) {
			const total = Math.max(0, Math.floor(ms / 1e3));
			const hours = Math.floor(total / 3600);
			const minutes = Math.floor(total % 3600 / 60);
			const seconds = total % 60;
			const ss = String(seconds).padStart(2, "0");
			return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
		}
		/**
		* Human label for an input device.
		* @param t - namespace translator.
		* @param device - device entry.
		* @param index - position among inputs (1-based label for unnamed devices).
		* @returns label text.
		*/
		function deviceText(t, device, index) {
			if (device.id === "") return t("device.default");
			return device.label === "" ? t("device.unnamed", { index: index + 1 }) : device.label;
		}
		/**
		* Join truthy class names.
		* @param names - class names or falsy placeholders.
		* @returns space-separated class attribute value.
		*/
		function cx(...names) {
			return names.filter(Boolean).join(" ");
		}
		//#endregion
		//#region src/client/icons.tsx
		/** Glyphs not shipped by ui-primitives, drawn on the same 16 px grid with currentColor. */
		/**
		* Microphone outline glyph.
		* @param props.size - rendered edge length in pixels.
		* @returns decorative SVG (aria-hidden).
		*/
		function MicIcon({ size = 16 }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				"aria-hidden": "true",
				focusable: "false",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "5.25",
					y: "1.5",
					width: "5.5",
					height: "8.5",
					rx: "2.75",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.3"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M3 7.5a5 5 0 0 0 10 0M8 12.5v2",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round"
				})]
			});
		}
		/**
		* Filled square stop glyph.
		* @param props.size - rendered edge length in pixels.
		* @returns decorative SVG (aria-hidden).
		*/
		function StopSquareIcon({ size = 16 }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				"aria-hidden": "true",
				focusable: "false",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "4",
					y: "4",
					width: "8",
					height: "8",
					rx: "1.5",
					fill: "currentColor"
				})
			});
		}
		//#endregion
		//#region \0dsh-css:packages/third-party/dsh-voice-capture/src/client/MicButton.module.css.mjs
		const css$2 = ".J47s-a_button{corner-shape:round;background:var(--dsw-specific-selector);width:28px;height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;display:grid;position:relative}.J47s-a_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}.J47s-a_button:disabled{opacity:.5;cursor:default}.J47s-a_button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.J47s-a_live{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-inverted)}.J47s-a_live:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);filter:brightness(1.08)}.J47s-a_live:after{border:2px solid var(--dsw-alias-state-error-primary);content:\"\";opacity:0;pointer-events:none;border-radius:999px;animation:1.4s ease-out infinite J47s-a_pulse;position:absolute;inset:-3px}.J47s-a_pending:after{border:1.5px solid var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);content:\"\";border-radius:999px;width:7px;height:7px;position:absolute;top:3px;right:3px}@keyframes J47s-a_pulse{0%{opacity:.7;transform:scale(.9)}to{opacity:0;transform:scale(1.25)}}@media (prefers-reduced-motion:reduce){.J47s-a_live:after{opacity:.5;animation:none}}";
		const tagId$2 = "dsh-voice-capture/MicButton.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-voice-capture";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var MicButton_module_css_default = {
			"button": "J47s-a_button",
			"live": "J47s-a_live",
			"pending": "J47s-a_pending",
			"pulse": "J47s-a_pulse"
		};
		//#endregion
		//#region src/client/MicButton.tsx
		/** Composer tool-row microphone toggle: idle → record, recording → stop. */
		function MicButton({ t, useVoice, useSession, start, stop, detach, refreshDevices }) {
			const phase = useVoice((snapshot) => snapshot.phase);
			const supported = useVoice((snapshot) => snapshot.supported);
			const subagent = useSession((snapshot) => snapshot.subagent !== null);
			(0, react.useEffect)(() => {
				refreshDevices();
				return () => {
					detach();
				};
			}, [detach, refreshDevices]);
			const live = phase === "requesting" || phase === "recording";
			const working = phase === "encoding" || phase === "sending";
			const disabled = !supported || subagent || working;
			const label = !supported ? t("mic.unsupported") : subagent ? t("mic.subagent") : live ? t("mic.stop") : working ? t("mic.busy") : phase === "preview" ? t("mic.pending") : t("mic.start");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label,
				side: "top",
				delayMs: 500,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: cx(MicButton_module_css_default.button, live && MicButton_module_css_default.live, phase === "preview" && MicButton_module_css_default.pending),
					"aria-label": label,
					"aria-pressed": live,
					"data-testid": "dsh-voice-capture-mic",
					"data-phase": phase,
					disabled,
					onMouseDown: (event) => {
						event.preventDefault();
					},
					onClick: () => {
						if (live) stop();
						else if (phase === "preview") document.getElementById("dsh-voice-capture-send")?.focus();
						else start();
					},
					children: live ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StopSquareIcon, { size: 14 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MicIcon, { size: 14 })
				})
			});
		}
		//#endregion
		//#region \0dsh-css:packages/third-party/dsh-voice-capture/src/client/VoiceDock.module.css.mjs
		const css$1 = ".u4KFHa_root{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));max-width:calc(var(--dsh-composer-card-max-width,100%) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);color:var(--dsw-alias-label-primary);border-radius:12px;flex:none;margin:0 auto;font-size:13px;line-height:20px}.u4KFHa_body{flex-direction:column;gap:8px;padding:8px 12px;display:flex}.u4KFHa_row{flex-wrap:wrap;align-items:center;gap:8px;min-height:28px;display:flex}.u4KFHa_spacer{flex:auto}.u4KFHa_nowrap{flex-wrap:nowrap}.u4KFHa_truncate{text-overflow:ellipsis;white-space:nowrap;flex:auto;min-width:0;overflow:hidden}.u4KFHa_lead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}.u4KFHa_title{flex:none;font-weight:500}.u4KFHa_caption{color:var(--dsw-alias-label-secondary);font-size:12px}.u4KFHa_timer{font-variant-numeric:tabular-nums;flex:none;font-weight:500}.u4KFHa_limit{color:var(--dsw-alias-label-tertiary);font-weight:400}.u4KFHa_recDot{background:var(--dsw-alias-state-error-primary);border-radius:999px;flex:none;width:10px;height:10px;animation:1.2s ease-in-out infinite u4KFHa_blink}.u4KFHa_meter,.u4KFHa_progress{background:var(--dsw-alias-bg-layer-3);border-radius:999px;flex:0 120px;min-width:60px;height:6px;position:relative;overflow:hidden}.u4KFHa_progress{flex-basis:200px}.u4KFHa_meterFill,.u4KFHa_progressFill{transform-origin:0;border-radius:inherit;transition:transform 90ms linear;position:absolute;inset:0}.u4KFHa_meterFill{background:var(--dsw-alias-state-success-primary)}.u4KFHa_progressFill{background:var(--dsw-alias-brand-primary)}.u4KFHa_player{width:100%;height:36px;display:block}.u4KFHa_notice{color:var(--dsw-alias-state-warn-label);font-size:12px}.u4KFHa_error{color:var(--dsw-alias-state-error-primary);align-items:flex-start}.u4KFHa_errorText{flex:240px}.u4KFHa_iconButton{width:24px;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;place-items:center;display:grid}.u4KFHa_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.u4KFHa_device{flex:0 auto;min-width:0;display:inline-flex}.u4KFHa_select{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);max-width:260px;height:28px;color:var(--dsw-alias-label-primary);font:inherit;text-overflow:ellipsis;border-radius:8px;padding:0 8px;font-size:12px}.u4KFHa_spinner{border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:999px;flex:none;width:14px;height:14px;animation:.8s linear infinite u4KFHa_spin}.u4KFHa_srOnly{clip:rect(0 0 0 0);white-space:nowrap;border:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}@keyframes u4KFHa_blink{0%,to{opacity:1}50%{opacity:.35}}@keyframes u4KFHa_spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.u4KFHa_recDot,.u4KFHa_spinner{animation:none}.u4KFHa_meterFill,.u4KFHa_progressFill{transition:none}}";
		const tagId$1 = "dsh-voice-capture/VoiceDock.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-voice-capture";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var VoiceDock_module_css_default = {
			"blink": "u4KFHa_blink",
			"body": "u4KFHa_body",
			"caption": "u4KFHa_caption",
			"device": "u4KFHa_device",
			"error": "u4KFHa_error",
			"errorText": "u4KFHa_errorText",
			"iconButton": "u4KFHa_iconButton",
			"lead": "u4KFHa_lead",
			"limit": "u4KFHa_limit",
			"meter": "u4KFHa_meter",
			"meterFill": "u4KFHa_meterFill",
			"notice": "u4KFHa_notice",
			"nowrap": "u4KFHa_nowrap",
			"player": "u4KFHa_player",
			"progress": "u4KFHa_progress",
			"progressFill": "u4KFHa_progressFill",
			"recDot": "u4KFHa_recDot",
			"root": "u4KFHa_root",
			"row": "u4KFHa_row",
			"select": "u4KFHa_select",
			"spacer": "u4KFHa_spacer",
			"spin": "u4KFHa_spin",
			"spinner": "u4KFHa_spinner",
			"srOnly": "u4KFHa_srOnly",
			"timer": "u4KFHa_timer",
			"title": "u4KFHa_title",
			"truncate": "u4KFHa_truncate"
		};
		//#endregion
		//#region src/client/VoiceDock.tsx
		/** How long the post-send confirmation line stays visible. */
		const SENT_NOTICE_MS = 6e3;
		/**
		* Full-width recording panel above the composer: live status and timer,
		* level meter, device choice, preview player, discard / re-record / send,
		* upload progress and recoverable errors. Renders nothing while idle.
		*/
		function VoiceDock({ t, useVoice, useGate, useInput, inputActions, start, stop, cancel, send, selectDevice, dismissError }) {
			const voice = useVoice((snapshot) => snapshot);
			const gate = useGate((snapshot) => snapshot.state);
			const gated = gate !== "ready" && gate !== "static" && gate !== "unknown";
			const draft = useInput((state) => state.draft);
			const references = useInput((state) => state.occurrences.length);
			const latestDraft = (0, react.useRef)(draft);
			latestDraft.current = draft;
			const player = (0, react.useRef)(null);
			const [sentVisible, setSentVisible] = (0, react.useState)(false);
			const lastSentAt = voice.lastSent?.at;
			(0, react.useEffect)(() => {
				if (lastSentAt === void 0) return;
				setSentVisible(true);
				const timer = setTimeout(() => {
					setSentVisible(false);
				}, SENT_NOTICE_MS);
				return () => {
					clearTimeout(timer);
				};
			}, [lastSentAt]);
			(0, react.useEffect)(() => {
				if (voice.phase !== "preview") player.current?.pause();
			}, [voice.phase]);
			const phase = voice.phase;
			if (phase === "idle" && !(sentVisible && voice.lastSent !== void 0)) return null;
			const includeDraft = references === 0 && draft.trim() !== "";
			const onSend = async () => {
				player.current?.pause();
				const text = includeDraft ? draft : "";
				if (await send(text) === "sent" && text !== "" && latestDraft.current === text) inputActions.setDraft("");
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
				className: VoiceDock_module_css_default.root,
				"aria-label": t("panel.label"),
				"data-testid": "dsh-voice-capture-panel",
				"data-phase": phase,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: VoiceDock_module_css_default.body,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: VoiceDock_module_css_default.srOnly,
							"aria-live": "polite",
							children: liveMessage(t, voice)
						}),
						phase === "requesting" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: VoiceDock_module_css_default.row,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: VoiceDock_module_css_default.lead,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MicIcon, { size: 16 })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: VoiceDock_module_css_default.title,
									children: t("status.requesting")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: VoiceDock_module_css_default.spacer }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									size: "sm",
									variant: "ghost",
									onClick: cancel,
									children: t("action.cancel")
								})
							]
						}),
						phase === "recording" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: cx(VoiceDock_module_css_default.row, VoiceDock_module_css_default.nowrap),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: VoiceDock_module_css_default.recDot,
									"aria-hidden": "true"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: VoiceDock_module_css_default.title,
									children: t("status.recording")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: VoiceDock_module_css_default.timer,
									"data-testid": "dsh-voice-capture-timer",
									"aria-label": t("timer.label", {
										elapsed: clockText(voice.elapsedMs),
										limit: clockText(voice.limitMs)
									}),
									children: [clockText(voice.elapsedMs), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: VoiceDock_module_css_default.limit,
										children: [" / ", clockText(voice.limitMs)]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: VoiceDock_module_css_default.meter,
									role: "meter",
									"aria-label": t("level.label"),
									"aria-valuemin": 0,
									"aria-valuemax": 100,
									"aria-valuenow": Math.round(voice.level * 100),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: VoiceDock_module_css_default.meterFill,
										style: { transform: `scaleX(${voice.level.toFixed(3)})` }
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: cx(VoiceDock_module_css_default.caption, VoiceDock_module_css_default.truncate),
									title: voice.activeDeviceLabel,
									children: voice.activeDeviceLabel === "" ? "" : t("device.recordingWith", { name: voice.activeDeviceLabel })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									size: "sm",
									variant: "ghost",
									onClick: cancel,
									children: t("action.discard")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									size: "sm",
									variant: "primary",
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StopSquareIcon, { size: 14 }),
									onClick: stop,
									"data-testid": "dsh-voice-capture-stop",
									children: t("action.stop")
								})
							]
						}),
						phase === "encoding" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: VoiceDock_module_css_default.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: VoiceDock_module_css_default.spinner,
								"aria-hidden": "true"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: VoiceDock_module_css_default.title,
								children: t("status.encoding")
							})]
						}),
						(phase === "preview" || phase === "sending") && voice.clip !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: VoiceDock_module_css_default.row,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: VoiceDock_module_css_default.title,
										children: t("status.preview")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: VoiceDock_module_css_default.caption,
										"data-testid": "dsh-voice-capture-details",
										children: t("clip.details", {
											duration: clockText(voice.clip.durationMs),
											size: (0, _deepseek_ai_dsh_client_ui_primitives.fileSizeText)(voice.clip.bytes),
											rate: voice.clip.sampleRate / 1e3
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: VoiceDock_module_css_default.spacer }),
									phase === "preview" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DeviceSelect, {
										voice,
										t,
										onSelect: selectDevice
									})
								]
							}),
							voice.clip.limitReached && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: VoiceDock_module_css_default.notice,
								children: t("status.limitReached", { limit: clockText(voice.limitMs) })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("audio", {
								ref: player,
								className: VoiceDock_module_css_default.player,
								controls: true,
								preload: "metadata",
								src: voice.clip.url,
								"aria-label": t("clip.player"),
								"data-testid": "dsh-voice-capture-preview"
							}),
							voice.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorLine, {
								voice,
								t,
								onDismiss: dismissError
							}),
							phase === "sending" && voice.progress !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: VoiceDock_module_css_default.row,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: VoiceDock_module_css_default.progress,
										role: "progressbar",
										"aria-valuemin": 0,
										"aria-valuemax": 100,
										"aria-valuenow": percent(voice),
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: VoiceDock_module_css_default.progressFill,
											style: { transform: `scaleX(${(percent(voice) / 100).toFixed(3)})` }
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: VoiceDock_module_css_default.caption,
										children: voice.progress.stage === "uploading" ? t("status.uploading", { percent: percent(voice) }) : t("status.submitting")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: VoiceDock_module_css_default.spacer }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										size: "sm",
										variant: "ghost",
										onClick: cancel,
										children: t("action.cancelSend")
									})
								]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: VoiceDock_module_css_default.row,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: VoiceDock_module_css_default.caption,
										children: gate === "live-only" ? t("gate.live-only") : gated ? t("live.gated", { reason: t(`gate.${gate}`) }) : includeDraft ? t("clip.withDraft") : references > 0 && draft.trim() !== "" ? t("clip.withReferences") : t("clip.audioOnly")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: VoiceDock_module_css_default.spacer }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										size: "sm",
										variant: "ghost",
										onClick: cancel,
										"data-testid": "dsh-voice-capture-discard",
										children: t("action.discard")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										size: "sm",
										variant: "outline",
										icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MicIcon, { size: 14 }),
										onClick: start,
										children: t("action.rerecord")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										id: "dsh-voice-capture-send",
										size: "sm",
										variant: "primary",
										icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSendOutline16, { size: 14 }),
										onClick: () => {
											onSend();
										},
										disabled: gated,
										"data-gate": gate,
										"data-testid": "dsh-voice-capture-send",
										children: t("action.send")
									})
								]
							})
						] }),
						phase === "error" && voice.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorLine, {
							voice,
							t,
							onDismiss: dismissError
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: VoiceDock_module_css_default.row,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: VoiceDock_module_css_default.spacer }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DeviceSelect, {
									voice,
									t,
									onSelect: selectDevice
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									size: "sm",
									variant: "outline",
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MicIcon, { size: 14 }),
									onClick: start,
									"data-testid": "dsh-voice-capture-retry",
									children: t("action.retry")
								})
							]
						})] }),
						phase === "idle" && voice.lastSent !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: VoiceDock_module_css_default.row,
							"data-testid": "dsh-voice-capture-sent",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: VoiceDock_module_css_default.caption,
								children: t("status.sent", { name: voice.lastSent.name })
							})
						})
					]
				})
			});
		}
		function percent(voice) {
			const progress = voice.progress;
			if (progress === void 0) return 0;
			if (progress.stage === "submitting") return 100;
			const total = progress.total ?? voice.clip?.bytes ?? 0;
			return total > 0 ? Math.min(100, Math.round(progress.loaded * 100 / total)) : 0;
		}
		function liveMessage(t, voice) {
			switch (voice.phase) {
				case "requesting": return t("status.requesting");
				case "recording": return t("status.recording");
				case "encoding": return t("status.encoding");
				case "preview": return voice.error === void 0 ? t("status.preview") : t(`error.${voice.error.code}`);
				case "sending": return voice.progress?.stage === "submitting" ? t("status.submitting") : "";
				case "error": return voice.error === void 0 ? "" : t(`error.${voice.error.code}`);
				case "idle": return voice.lastSent === void 0 ? "" : t("status.sent", { name: voice.lastSent.name });
				default: return "";
			}
		}
		function ErrorLine({ voice, t, onDismiss }) {
			const error = voice.error;
			if (error === void 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: cx(VoiceDock_module_css_default.row, VoiceDock_module_css_default.error),
				role: "alert",
				"data-testid": "dsh-voice-capture-error",
				"data-code": error.code,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: VoiceDock_module_css_default.lead,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, { size: 16 })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: VoiceDock_module_css_default.errorText,
						children: [t(`error.${error.code}`), error.detail !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: VoiceDock_module_css_default.caption,
							children: [" ", t("error.detail", { detail: error.detail })]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: VoiceDock_module_css_default.spacer }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: VoiceDock_module_css_default.iconButton,
						"aria-label": t("action.dismiss"),
						onClick: onDismiss,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, { size: 14 })
					})
				]
			});
		}
		function DeviceSelect({ voice, t, onSelect }) {
			const devices = voice.devices.some((device) => device.id === "") ? voice.devices : [{
				id: "",
				label: ""
			}, ...voice.devices];
			const selectedKnown = devices.some((device) => device.id === voice.selectedDeviceId);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: VoiceDock_module_css_default.device,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: VoiceDock_module_css_default.srOnly,
					children: t("device.label")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
					className: VoiceDock_module_css_default.select,
					value: selectedKnown ? voice.selectedDeviceId : "",
					onChange: (event) => {
						onSelect(event.currentTarget.value);
					},
					"data-testid": "dsh-voice-capture-device",
					children: devices.map((device, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: device.id,
						children: deviceText(t, device, index)
					}, device.id === "" ? "default" : device.id))
				})]
			});
		}
		//#endregion
		//#region src/client/audio/gate.ts
		/** Every state name a control may display. */
		const GATE_STATES = [
			"unknown",
			"static",
			"cold",
			"queued",
			"stopping",
			"loading",
			"activating",
			"unloading",
			"ready",
			"busy",
			"error",
			"failed",
			"live-only"
		];
		const OPEN = new Set([
			"ready",
			"static",
			"unknown"
		]);
		/**
		* Whether the state forbids sending to the model.
		* @param gate - combined state.
		* @returns true while the model is not usable.
		*/
		function gateBlocks(gate) {
			return !OPEN.has(gate.state);
		}
		/**
		* Parse an activation value from a capability entry (`activation` / `availability`) or a `model.state` event.
		* @param value - raw value.
		* @param source - publisher.
		* @returns the state, or undefined when the value carries none.
		*/
		function parseGate(value, source) {
			if (typeof value !== "object" || value === null) return void 0;
			const raw = value;
			const state = raw.state;
			if (typeof state !== "string" || !GATE_STATES.includes(state)) return void 0;
			const text = (key) => typeof raw[key] === "string" && raw[key] !== "" ? { [key]: raw[key] } : {};
			const progress = typeof raw.progress === "number" && Number.isFinite(raw.progress) ? { progress: raw.progress } : {};
			return {
				state,
				source,
				...text("detail"),
				...text("reason"),
				...text("code"),
				...text("message"),
				...text("since"),
				...progress
			};
		}
		/**
		* Combine the library and adapter views: any blocking report wins (library first, it names the job);
		* otherwise a positive library report, then the adapter's.
		* @param library - library service state (undefined when the service is absent).
		* @param adapter - adapter activation state (undefined for hosts before 0.4.0).
		* @returns combined state.
		*/
		function combineGate(library, adapter) {
			const lib = library === void 0 ? void 0 : {
				...library,
				source: "library"
			};
			const host = adapter === void 0 ? void 0 : {
				...adapter,
				source: "adapter"
			};
			if (lib !== void 0 && gateBlocks(lib)) return lib;
			if (host !== void 0 && gateBlocks(host)) return host;
			if (lib !== void 0 && lib.state !== "unknown") return lib;
			if (host !== void 0) return host;
			return lib ?? { state: "unknown" };
		}
		/**
		* Stable key for snapshot memoization.
		* @param gate - state.
		* @returns string key.
		*/
		function gateKey(gate) {
			return JSON.stringify(gate);
		}
		const modelKey = (provider, model) => JSON.stringify([provider, model]);
		/**
		* Page-wide activation facts: the library service (looked up on every read, it may load after this
		* plugin) and adapter `model.state` events that arrived after the last capability document.
		*/
		var ActivationBoard = class {
			library;
			now;
			events = /* @__PURE__ */ new Map();
			listeners = /* @__PURE__ */ new Set();
			librarySubscription;
			/**
			* @param library - current library service, if provided.
			* @param now - clock (ms).
			*/
			constructor(library, now = () => Date.now()) {
				this.library = library;
				this.now = now;
			}
			/**
			* Apply a `model.state` feed event.
			* @param event - feed event.
			* @returns whether it named a model.
			*/
			handleModelState(event) {
				const provider = event.provider;
				const model = event.model ?? event.modelId;
				const gate = parseGate(event, "adapter");
				if (typeof provider !== "string" || typeof model !== "string" || gate === void 0) return false;
				this.events.set(modelKey(provider, model), {
					gate,
					at: this.now()
				});
				this.notify();
				return true;
			}
			/**
			* Forget events that a capability document fetched after them already reflects.
			* @param since - fetch start time (ms).
			*/
			documentLoaded(since) {
				let changed = false;
				for (const [key, entry] of this.events) {
					if (entry.at > since) continue;
					this.events.delete(key);
					changed = true;
				}
				if (changed) this.notify();
			}
			/** Re-read the library service (it was provided or removed). */
			libraryChanged() {
				this.syncLibrary();
				this.notify();
			}
			/**
			* Combined gate of one model.
			* @param provider - provider id.
			* @param model - model id.
			* @param entry - capability entry, when the adapter serves the model.
			* @returns state.
			*/
			gate(provider, model, entry) {
				let library;
				try {
					library = parseGate(this.library()?.status(provider, model).getSnapshot(), "library");
				} catch {
					library = void 0;
				}
				const facts = entry;
				const adapter = this.events.get(modelKey(provider, model))?.gate ?? parseGate(facts?.activation, "adapter") ?? parseGate(facts?.availability, "adapter");
				const combined = combineGate(library, adapter);
				return this.canOpenLibrary ? {
					...combined,
					library: true
				} : combined;
			}
			/**
			* Open the library view when the service is present.
			* @param sessionId - conversation to target.
			* @returns whether the library was opened.
			*/
			openLibrary(sessionId) {
				const face = this.library();
				if (face?.open === void 0) return false;
				face.open({ sessionId });
				return true;
			}
			/** Whether the library service can be opened. */
			get canOpenLibrary() {
				return this.library()?.open !== void 0;
			}
			/**
			* @param listener - called on any activation change.
			* @returns unsubscribe.
			*/
			subscribe(listener) {
				this.listeners.add(listener);
				this.syncLibrary();
				return () => {
					this.listeners.delete(listener);
					if (this.listeners.size === 0) this.syncLibrary();
				};
			}
			syncLibrary() {
				const face = this.listeners.size === 0 ? void 0 : this.library();
				if (this.librarySubscription?.face === face) return;
				this.librarySubscription?.stop();
				this.librarySubscription = void 0;
				if (face === void 0) return;
				try {
					const source = face.document?.() ?? face.status("", "");
					this.librarySubscription = {
						face,
						stop: source.subscribe(() => {
							this.notify();
						})
					};
				} catch {}
			}
			notify() {
				for (const listener of [...this.listeners]) listener();
			}
		};
		//#endregion
		//#region src/client/audio/api.ts
		/**
		* Browser client for the audio adapter's authenticated Fetch routes
		* (`parallel-work/streaming/CONTRACT.md` v0.1 §2–§6). Requests are relative
		* to the page origin, so Web (`http://…/api`) and Desktop
		* (`dsh-app://app/api`) share one code path and cookies/Connection auth ride
		* the same origin. The browser never contacts a model server.
		*/
		/** Route prefix owned by the audio adapter package. */
		const ROUTE_PREFIX = "/api/dsh-dgx-audio/v1";
		/** Business failure body shared by every route. */
		var AudioRouteError = class extends Error {
			/** Contract error code, or `HTTP_<status>` when the body carried none. */
			code;
			/** HTTP status. */
			status;
			/**
			* @param status - HTTP status.
			* @param code - contract error code.
			* @param message - human-readable detail.
			*/
			constructor(status, code, message) {
				super(message);
				this.name = "AudioRouteError";
				this.status = status;
				this.code = code;
			}
		};
		/**
		* Resolve a contract path against the page location.
		* @param path - absolute path beginning with `/api/`.
		* @param base - page URL (defaults to `location.href`).
		* @returns absolute URL string on the page origin.
		*/
		function routeUrl(path, base = globalThis.location?.href ?? "http://localhost/") {
			return new URL(path, base).toString();
		}
		/**
		* Call a JSON route and unwrap `{ ok:false, error }` bodies.
		* @param fetchImpl - fetch implementation.
		* @param path - route path including query.
		* @param init - request init.
		* @returns the parsed JSON body.
		* @throws {AudioRouteError} for non-2xx or `ok:false` bodies.
		*/
		async function requestJson(fetchImpl, path, init = {}) {
			const response = await fetchImpl(routeUrl(path), {
				credentials: "include",
				...init
			});
			const text = await response.text();
			let body;
			try {
				body = text === "" ? void 0 : JSON.parse(text);
			} catch {
				throw new AudioRouteError(response.status, `HTTP_${response.status}`, text.slice(0, 200));
			}
			const failure = isRecord(body) && body.ok === false && isRecord(body.error) ? body.error : void 0;
			if (!response.ok || failure !== void 0) throw new AudioRouteError(response.status, typeof failure?.code === "string" ? failure.code : `HTTP_${response.status}`, typeof failure?.message === "string" ? failure.message : response.statusText);
			return body;
		}
		/**
		* Incremental NDJSON decoder: accepts arbitrary byte fragments and yields
		* one parsed object per complete `\n`-terminated line. Lines longer than
		* `maxLineBytes` and malformed JSON are reported, not thrown.
		*/
		var NdjsonDecoder = class {
			maxLineBytes;
			decoder = new TextDecoder();
			pending = "";
			/** @param maxLineBytes - upper bound for one buffered line (audio chunks are base64 PCM). */
			constructor(maxLineBytes = 8 * 1024 * 1024) {
				this.maxLineBytes = maxLineBytes;
			}
			/**
			* Feed bytes.
			* @param bytes - next fragment.
			* @returns decoded objects and parse errors in arrival order.
			*/
			push(bytes) {
				this.pending += this.decoder.decode(bytes, { stream: true });
				return this.drain(false);
			}
			/**
			* Flush the final unterminated line at end of stream.
			* @returns decoded objects and parse errors.
			*/
			end() {
				this.pending += this.decoder.decode();
				return this.drain(true);
			}
			drain(final) {
				const values = [];
				const errors = [];
				let newline = this.pending.indexOf("\n");
				while (newline >= 0) {
					this.take(this.pending.slice(0, newline), values, errors);
					this.pending = this.pending.slice(newline + 1);
					newline = this.pending.indexOf("\n");
				}
				if (final && this.pending.trim() !== "") {
					this.take(this.pending, values, errors);
					this.pending = "";
				}
				if (this.pending.length > this.maxLineBytes) {
					errors.push(`line exceeds ${this.maxLineBytes} bytes`);
					this.pending = "";
				}
				return {
					values,
					errors
				};
			}
			take(line, values, errors) {
				const trimmed = line.trim();
				if (trimmed === "") return;
				try {
					values.push(JSON.parse(trimmed));
				} catch {
					errors.push(`malformed line: ${trimmed.slice(0, 80)}`);
				}
			}
		};
		/**
		* Narrow an unknown value to a plain record.
		* @param value - candidate.
		* @returns whether it is a non-null object.
		*/
		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		//#endregion
		//#region src/client/audio/task-controller.ts
		const EMPTY = {
			values: {},
			references: {},
			consents: {},
			reference: void 0,
			referenceConsent: false,
			referenceText: "",
			phase: "idle",
			error: void 0,
			lastSentAt: void 0,
			params: "unset",
			paramsDetail: void 0
		};
		/** File name prefix per slot; the adapter selects clips by these attachment names. */
		const SLOT_PREFIX = {
			referenceAudio: "reference-voice",
			referenceAudio2: "reference-voice-2",
			emotionAudio: "emotion-reference",
			imageReference: "image-reference",
			audioReference: "audio-reference"
		};
		/** Delay before edited values are applied as session params. */
		const PARAMS_DEBOUNCE_MS = 400;
		/** Parameter keys the reference box supplies itself. */
		const REFERENCE_KEYS = new Set(["refText"]);
		/** Largest accepted reference file (bytes). */
		const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
		const REFERENCE_TYPES = /^audio\/(wav|x-wav|wave|mpeg|mp3|flac|x-flac|ogg|opus|webm|mp4|x-m4a|aac)$/;
		/** Image types the host forwards as `image_reference` (TASK_CONTRACT §K.7: png/jpg/webp/gif/bmp). */
		const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif|bmp)$/;
		function stamp(date) {
			const pad = (n) => String(n).padStart(2, "0");
			return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
		}
		/** Page-wide task input controller. */
		var TaskInputsController = class {
			upload;
			sessions;
			fetchImpl;
			now;
			states = /* @__PURE__ */ new Map();
			listeners = /* @__PURE__ */ new Set();
			sources = /* @__PURE__ */ new Map();
			/**
			* @param upload - file upload service.
			* @param sessions - Session bindings.
			* @param fetchImpl - page fetch for `session-params`.
			* @param now - wall clock.
			*/
			constructor(upload, sessions, fetchImpl = void 0, now = () => Date.now()) {
				this.upload = upload;
				this.sessions = sessions;
				this.fetchImpl = fetchImpl;
				this.now = now;
			}
			/**
			* Identity-stable observable for one Session.
			* @param sessionId - Session id.
			* @returns source.
			*/
			source(sessionId) {
				let source = this.sources.get(sessionId);
				if (source === void 0) {
					source = {
						getSnapshot: () => this.state(sessionId).snapshot,
						subscribe: (listener) => {
							this.listeners.add(listener);
							return () => {
								this.listeners.delete(listener);
							};
						}
					};
					this.sources.set(sessionId, source);
				}
				return source;
			}
			/**
			* Set one parameter value for one model.
			* @param sessionId - Session id.
			* @param model - Harness model id the value belongs to.
			* @param key - parameter key.
			* @param value - raw value.
			* @param target - adapter model to apply session params to after a short delay.
			*/
			setValue(sessionId, model, key, value, target) {
				const state = this.state(sessionId);
				const current = state.snapshot.values[model] ?? {};
				this.update(sessionId, { values: {
					...state.snapshot.values,
					[model]: {
						...current,
						[key]: value
					}
				} });
				if (target === void 0 || this.fetchImpl === void 0) return;
				clearTimeout(state.paramsTimer);
				state.paramsTimer = setTimeout(() => {
					this.applyParams(sessionId, target);
				}, PARAMS_DEBOUNCE_MS);
			}
			/**
			* Apply the user-set values with `POST session-params` (TASK_CONTRACT 0.2 §D).
			* @param sessionId - Session id.
			* @param target - selected adapter model.
			* @returns whether the host accepted them (true when nothing was set).
			*/
			async applyParams(sessionId, target) {
				const state = this.state(sessionId);
				clearTimeout(state.paramsTimer);
				state.paramsTimer = void 0;
				if (this.fetchImpl === void 0) return true;
				const values = state.snapshot.values[target.model] ?? {};
				const params = this.requestOptions(values, target.view);
				if (Object.keys(values).length === 0) return true;
				const run = ++state.paramsRun;
				this.update(sessionId, {
					params: "applying",
					paramsDetail: void 0
				});
				try {
					await requestJson(this.fetchImpl, `${ROUTE_PREFIX}/session-params`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							sessionId,
							provider: target.provider,
							model: target.model,
							params
						})
					});
					if (run === state.paramsRun) this.update(sessionId, {
						params: "applied",
						paramsDetail: void 0
					});
					return true;
				} catch (error) {
					const status = error.status;
					const code = error.code;
					if (run === state.paramsRun) this.update(sessionId, {
						params: status === 404 || status === 405 ? "unsupported" : "failed",
						paramsDetail: `${code ?? ""} ${error instanceof Error ? error.message : String(error)}`.trim()
					});
					return false;
				}
			}
			/**
			* Hold a reference clip (recorded bytes or a picked file) for one slot. Consent for that slot resets.
			* @param sessionId - Session id.
			* @param data - clip content.
			* @param source - how the clip was obtained.
			* @param originalName - picked file name (extension kept).
			* @param slot - attachment slot.
			*/
			setReference(sessionId, data, source, originalName = "reference.wav", slot = "referenceAudio") {
				if (data.size > MAX_REFERENCE_BYTES) {
					this.update(sessionId, { error: {
						code: "reference-too-large",
						detail: String(data.size)
					} });
					return;
				}
				const type = data.type === "" ? slot === "imageReference" ? "image/png" : "audio/wav" : data.type;
				if (!(slot === "imageReference" ? IMAGE_TYPES : REFERENCE_TYPES).test(type)) {
					this.update(sessionId, { error: {
						code: "reference-type",
						detail: type
					} });
					return;
				}
				this.clearReference(sessionId, slot);
				const extension = /\.([A-Za-z0-9]{2,5})$/.exec(originalName)?.[1]?.toLowerCase() ?? "wav";
				const name = `${SLOT_PREFIX[slot]}-${stamp(new Date(this.now()))}.${extension}`;
				const file = new File([data], name, { type });
				const state = this.state(sessionId);
				state.files[slot] = file;
				this.update(sessionId, {
					references: {
						...state.snapshot.references,
						[slot]: {
							name,
							url: URL.createObjectURL(file),
							bytes: file.size,
							type,
							source
						}
					},
					consents: {
						...state.snapshot.consents,
						[slot]: false
					},
					error: void 0
				});
			}
			/**
			* Drop the clip of one slot.
			* @param sessionId - Session id.
			* @param slot - attachment slot.
			*/
			clearReference(sessionId, slot = "referenceAudio") {
				const state = this.state(sessionId);
				const url = state.snapshot.references[slot]?.url;
				delete state.files[slot];
				if (url !== void 0) setTimeout(() => {
					URL.revokeObjectURL(url);
				}, 0);
				const references = { ...state.snapshot.references };
				delete references[slot];
				this.update(sessionId, {
					references,
					consents: {
						...state.snapshot.consents,
						[slot]: false
					}
				});
			}
			/**
			* Record the user's permission to use the voice in one slot.
			* @param sessionId - Session id.
			* @param consent - checkbox state.
			* @param slot - attachment slot.
			*/
			setConsent(sessionId, consent, slot = "referenceAudio") {
				this.update(sessionId, { consents: {
					...this.state(sessionId).snapshot.consents,
					[slot]: consent
				} });
			}
			/**
			* Transcript of the reference clip.
			* @param sessionId - Session id.
			* @param text - transcript text.
			*/
			setReferenceText(sessionId, text) {
				this.update(sessionId, { referenceText: text });
			}
			/** @param sessionId - Session id. */
			dismissError(sessionId) {
				this.update(sessionId, { error: void 0 });
			}
			/**
			* Extra parts for a request to `model` (options block and consented reference clip).
			* @param sessionId - Session id.
			* @param model - Harness model id.
			* @param view - task view.
			* @returns extras (undefined members when not applicable).
			*/
			extras(sessionId, model, view) {
				const state = this.state(sessionId);
				const options = this.requestOptions(state.snapshot.values[model] ?? {}, view);
				const references = REFERENCE_SLOTS.flatMap((slot) => {
					const file = state.files[slot];
					return view.input[slot] !== "none" && file !== void 0 && state.snapshot.consents[slot] === true ? [{
						slot,
						file,
						name: file.name
					}] : [];
				});
				const nameOf = (slot) => references.find((r) => r.slot === slot)?.name;
				const main = nameOf("referenceAudio");
				const referenceText = view.input.referenceText === "none" || main === void 0 ? void 0 : state.snapshot.referenceText.trim();
				return {
					references,
					block: Object.keys(options).length > 0 || references.length > 0 ? optionsBlock(model, options, references.length === 0 ? void 0 : {
						...main === void 0 ? {} : { name: main },
						...referenceText === void 0 ? {} : { text: referenceText },
						...nameOf("referenceAudio2") === void 0 ? {} : { referenceAudio2: nameOf("referenceAudio2") },
						...nameOf("emotionAudio") === void 0 ? {} : { emotionAudio: nameOf("emotionAudio") },
						...nameOf("imageReference") === void 0 ? {} : { imageReference: nameOf("imageReference") },
						...nameOf("audioReference") === void 0 ? {} : { audioReference: nameOf("audioReference") }
					}) : void 0
				};
			}
			/** User-set values valid for the model (defaults stay with the host; reference keys come from the reference box). */
			requestOptions(values, view) {
				return resolveOptions(view.input.referenceText === "none" ? view.params : view.params.filter((p) => !REFERENCE_KEYS.has(p.key)), values, false);
			}
			/**
			* Send a text-input task request (e.g. speech or music generation) with its options and reference clip.
			* @param sessionId - Session id.
			* @param model - Harness model id.
			* @param view - task view.
			* @param text - request text (the composer draft).
			* @param blocked - activation check run before upload and again before admission.
			* @returns whether the prompt was admitted.
			*/
			async generate(sessionId, model, view, text, blocked) {
				const state = this.state(sessionId);
				if (state.snapshot.phase === "sending") return false;
				const notReady = blocked?.();
				if (notReady !== void 0) return this.failed(sessionId, "model-not-ready", notReady);
				const extras = this.extras(sessionId, model, view);
				const abort = new AbortController();
				state.abort = abort;
				this.update(sessionId, {
					phase: "sending",
					error: void 0
				});
				const uploads = [];
				for (const reference of extras.references) try {
					const uploaded = await this.upload.upload(sessionId, reference.file, reference.name, abort.signal, () => {});
					if (!uploaded.ok) return this.failed(sessionId, "upload-failed", `${uploaded.error.code}: ${uploaded.error.message}`);
					uploads.push({
						receiptId: uploaded.value.receiptId,
						ref: uploaded.value.file
					});
				} catch (error) {
					return this.failed(sessionId, abort.signal.aborted ? void 0 : "upload-failed", String(error));
				}
				const binding = this.sessions.binding(sessionId);
				if (binding === void 0) return this.failed(sessionId, "session-unavailable", "");
				const stillNotReady = blocked?.();
				if (stillNotReady !== void 0) return this.failed(sessionId, "model-not-ready", stillNotReady);
				const combined = withOptions(extras.block, text);
				const textParts = combined === "" ? [] : [combined];
				const submission = binding.session.beginSubmission({
					mode: "queue",
					text: combined,
					attachments: uploads.map((u) => ({
						type: "file",
						value: u.ref
					}))
				});
				try {
					const result = await binding.session.prompt([...uploads.map((u) => ({
						type: "file",
						receiptId: u.receiptId
					})), ...textParts.map((part) => ({
						type: "text",
						text: part
					}))], "queue", abort.signal, submission.requestId);
					if (!result.ok) return this.failed(sessionId, "prompt-failed", `${result.error.code}: ${result.error.message}`);
				} catch (error) {
					submission.abandon();
					return this.failed(sessionId, abort.signal.aborted ? void 0 : "prompt-failed", String(error));
				}
				state.abort = void 0;
				this.update(sessionId, {
					phase: "idle",
					lastSentAt: this.now()
				});
				return true;
			}
			/** @param sessionId - Session id whose in-flight request is cancelled. */
			cancel(sessionId) {
				this.state(sessionId).abort?.abort();
			}
			/** Release every reference URL (plugin unload). */
			dispose() {
				for (const [sessionId, state] of this.states) {
					state.abort?.abort();
					clearTimeout(state.paramsTimer);
					for (const slot of REFERENCE_SLOTS) if (state.snapshot.references[slot] !== void 0) this.clearReference(sessionId, slot);
				}
			}
			failed(sessionId, code, detail) {
				const state = this.state(sessionId);
				state.abort = void 0;
				this.update(sessionId, {
					phase: "idle",
					error: code === void 0 ? void 0 : {
						code,
						detail
					}
				});
				return false;
			}
			state(sessionId) {
				let state = this.states.get(sessionId);
				if (state === void 0) {
					state = {
						snapshot: EMPTY,
						files: {},
						abort: void 0,
						paramsTimer: void 0,
						paramsRun: 0
					};
					this.states.set(sessionId, state);
				}
				return state;
			}
			update(sessionId, patch) {
				const state = this.state(sessionId);
				const next = {
					...state.snapshot,
					...patch
				};
				state.snapshot = {
					...next,
					reference: next.references.referenceAudio,
					referenceConsent: next.consents.referenceAudio === true
				};
				for (const listener of [...this.listeners]) listener();
			}
		};
		//#endregion
		//#region \0dsh-css:packages/third-party/dsh-voice-capture/src/client/audio/audio.module.css.mjs
		const css = ".hbTdJq_replies{flex-direction:column;gap:8px;margin:4px 0 8px;display:flex}.hbTdJq_reply{border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:12px;flex-direction:column;gap:6px;padding:8px 12px;font-size:13px;line-height:20px;display:flex}.hbTdJq_replyHead,.hbTdJq_row{flex-wrap:wrap;align-items:center;gap:8px;min-height:28px;display:flex}.hbTdJq_nowrap{flex-wrap:nowrap}.hbTdJq_replyTitle,.hbTdJq_title{flex:none;font-weight:500}.hbTdJq_caption{color:var(--dsw-alias-label-secondary);font-size:12px}.hbTdJq_warn{color:var(--dsw-alias-state-warn-label)}.hbTdJq_truncate{text-overflow:ellipsis;white-space:nowrap;flex:auto;min-width:0;overflow:hidden}.hbTdJq_spacer{flex:auto}.hbTdJq_player{width:100%;height:36px;display:block}.hbTdJq_errorText{color:var(--dsw-alias-state-error-primary);font-size:12px}.hbTdJq_bar{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));max-width:calc(var(--dsh-composer-card-max-width,100%) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);color:var(--dsw-alias-label-primary);border-radius:12px;flex:none;margin:0 auto;padding:8px 12px;font-size:13px;line-height:20px}.hbTdJq_timer{font-variant-numeric:tabular-nums;flex:none;font-weight:500}.hbTdJq_recDot,.hbTdJq_speaking{border-radius:999px;flex:none;width:10px;height:10px;animation:1.2s ease-in-out infinite hbTdJq_blink}.hbTdJq_recDot{background:var(--dsw-alias-state-error-primary)}.hbTdJq_speaking{background:var(--dsw-alias-brand-primary)}.hbTdJq_meter{background:var(--dsw-alias-bg-layer-3);border-radius:999px;flex:0 120px;min-width:60px;height:6px;position:relative;overflow:hidden}.hbTdJq_meterFill{transform-origin:0;border-radius:inherit;background:var(--dsw-alias-state-success-primary);transition:transform 90ms linear;position:absolute;inset:0}.hbTdJq_transcript{background:var(--dsw-alias-bg-layer-1);white-space:pre-wrap;border-radius:8px;max-height:96px;padding:6px 8px;overflow:auto}.hbTdJq_toggle{color:var(--dsw-alias-label-secondary);cursor:pointer;align-items:center;gap:4px;font-size:12px;display:inline-flex}.hbTdJq_liveButton{corner-shape:round;background:var(--dsw-specific-selector);height:28px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border:none;border-radius:999px;flex:none;align-items:center;gap:6px;padding:0 10px;font-size:13px;display:inline-flex}.hbTdJq_liveButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}.hbTdJq_liveButton:disabled{opacity:.6;cursor:default}.hbTdJq_liveButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.hbTdJq_liveDot{background:var(--dsw-alias-state-success-primary);border-radius:999px;width:8px;height:8px}.hbTdJq_unverified .hbTdJq_liveDot{background:var(--dsw-alias-state-warn-primary)}.hbTdJq_liveActive .hbTdJq_liveDot{background:var(--dsw-alias-state-error-primary);animation:1.2s ease-in-out infinite hbTdJq_blink}@keyframes hbTdJq_blink{0%,to{opacity:1}50%{opacity:.35}}@media (prefers-reduced-motion:reduce){.hbTdJq_recDot,.hbTdJq_speaking,.hbTdJq_liveActive .hbTdJq_liveDot{animation:none}.hbTdJq_meterFill{transition:none}}.hbTdJq_resultGroup{flex-direction:column;gap:8px;display:flex}.hbTdJq_segments{flex-direction:column;gap:4px;max-height:280px;margin:0;padding:0;list-style:none;display:flex;overflow:auto}.hbTdJq_segment{align-items:baseline;gap:8px;display:flex}.hbTdJq_segmentTime{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;font-size:12px}.hbTdJq_speaker{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);border-radius:6px;flex:none;padding:0 6px;font-size:12px}.hbTdJq_segmentText,.hbTdJq_transcriptText{white-space:pre-wrap;word-break:break-word}.hbTdJq_taskChip{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:999px;flex:none;padding:2px 8px;font-size:12px;font-weight:500}.hbTdJq_param{align-items:center;gap:6px;min-width:0;display:inline-flex}.hbTdJq_paramWide{flex:220px}.hbTdJq_select,.hbTdJq_numberInput,.hbTdJq_textInput{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);height:28px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;padding:0 8px;font-size:12px}.hbTdJq_numberInput{width:72px}.hbTdJq_textInput{flex:auto;min-width:0}.hbTdJq_referenceBox{border:.5px dashed var(--dsw-alias-border-l2);border-radius:10px;flex-direction:column;gap:6px;padding:6px 8px;display:flex}.hbTdJq_iconButton{width:24px;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;place-items:center;display:grid}.hbTdJq_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.hbTdJq_partial{opacity:.65}.hbTdJq_liveChoice{flex-direction:column;gap:2px;min-width:0;max-width:320px;display:flex}.hbTdJq_wordList{flex-wrap:wrap;gap:4px 8px;max-height:120px;margin:0;padding:0;list-style:none;display:flex;overflow:auto}.hbTdJq_word{align-items:baseline;gap:4px;display:inline-flex}.hbTdJq_hiddenParams{color:var(--dsw-alias-text-tertiary);font-size:12px}.hbTdJq_video{background:#000;border-radius:8px;width:100%;max-height:320px}.hbTdJq_thumb{object-fit:contain;border-radius:6px;max-width:128px;max-height:72px}";
		const tagId = "dsh-voice-capture/audio.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-voice-capture";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var audio_module_css_default = {
			"bar": "hbTdJq_bar",
			"blink": "hbTdJq_blink",
			"caption": "hbTdJq_caption",
			"errorText": "hbTdJq_errorText",
			"hiddenParams": "hbTdJq_hiddenParams",
			"iconButton": "hbTdJq_iconButton",
			"liveActive": "hbTdJq_liveActive",
			"liveButton": "hbTdJq_liveButton",
			"liveChoice": "hbTdJq_liveChoice",
			"liveDot": "hbTdJq_liveDot",
			"meter": "hbTdJq_meter",
			"meterFill": "hbTdJq_meterFill",
			"nowrap": "hbTdJq_nowrap",
			"numberInput": "hbTdJq_numberInput",
			"param": "hbTdJq_param",
			"paramWide": "hbTdJq_paramWide",
			"partial": "hbTdJq_partial",
			"player": "hbTdJq_player",
			"recDot": "hbTdJq_recDot",
			"referenceBox": "hbTdJq_referenceBox",
			"replies": "hbTdJq_replies",
			"reply": "hbTdJq_reply",
			"replyHead": "hbTdJq_replyHead",
			"replyTitle": "hbTdJq_replyTitle",
			"resultGroup": "hbTdJq_resultGroup",
			"row": "hbTdJq_row",
			"segment": "hbTdJq_segment",
			"segmentText": "hbTdJq_segmentText",
			"segmentTime": "hbTdJq_segmentTime",
			"segments": "hbTdJq_segments",
			"select": "hbTdJq_select",
			"spacer": "hbTdJq_spacer",
			"speaker": "hbTdJq_speaker",
			"speaking": "hbTdJq_speaking",
			"taskChip": "hbTdJq_taskChip",
			"textInput": "hbTdJq_textInput",
			"thumb": "hbTdJq_thumb",
			"timer": "hbTdJq_timer",
			"title": "hbTdJq_title",
			"toggle": "hbTdJq_toggle",
			"transcript": "hbTdJq_transcript",
			"transcriptText": "hbTdJq_transcriptText",
			"truncate": "hbTdJq_truncate",
			"unverified": "hbTdJq_unverified",
			"video": "hbTdJq_video",
			"warn": "hbTdJq_warn",
			"word": "hbTdJq_word",
			"wordList": "hbTdJq_wordList"
		};
		//#endregion
		//#region src/client/audio/TaskStrip.tsx
		/** Tasks whose request text comes from the composer and is sent by this strip's action. */
		const TEXT_REQUEST_TASKS = new Set([
			"tts",
			"voice-clone",
			"music-generation",
			"sound-generation",
			"video-generation"
		]);
		/** Contract parameter keys with localized labels (TASK_CONTRACT 0.2 host TASK_PARAMS); other keys show as published. */
		const PARAM_LABELS = new Set([
			"voice",
			"instructions",
			"language",
			"taskType",
			"responseFormat",
			"maxNewTokens",
			"refText",
			"audioLength",
			"negativePrompt",
			"guidanceScale",
			"numInferenceSteps",
			"seed",
			"prompt",
			"timestampGranularities",
			"toLanguage",
			"overlapPolicy",
			"turnDetection",
			"speed",
			"sampleRate",
			"wordTimestamps",
			"xVectorOnlyMode",
			"nonStreamingMode",
			"initialCodecChunkFrames",
			"ambientSound",
			"durationSeconds",
			"extraParams"
		]);
		/** Extra attachment slots rendered after the main reference box. */
		const EXTRA_SLOTS = [
			"referenceAudio2",
			"emotionAudio",
			"imageReference",
			"audioReference"
		];
		/**
		* Load server-reported choices (`valuesFrom`, e.g. GET voices) for the given URLs.
		* @param urls - adapter route URLs.
		* @param loadValues - cached loader.
		* @returns choices per URL (`failed` when the server did not answer with a list).
		*/
		function useServerValues(urls, loadValues) {
			const [values, setValues] = (0, react.useState)({});
			const key = [...new Set(urls)].sort().join("\n");
			(0, react.useEffect)(() => {
				let alive = true;
				for (const url of key === "" ? [] : key.split("\n")) loadValues(url).then((list) => {
					if (alive) setValues((current) => ({
						...current,
						[url]: list
					}));
				}, () => {
					if (alive) setValues((current) => ({
						...current,
						[url]: "failed"
					}));
				});
				return () => {
					alive = false;
				};
			}, [key, loadValues]);
			return values;
		}
		function valuesFromOf(param) {
			return "valuesFrom" in param ? param.valuesFrom : void 0;
		}
		/** Parameters the reference box edits itself. */
		const REFERENCE_PARAMS = new Set(["refText"]);
		/**
		* Task strip above the composer for the selected adapter model: task and output
		* expectation, activation gate, parameters, reference voice with consent, the
		* input checklist and, for text-input generation tasks, the Generate action.
		* Renders nothing for models the audio adapter does not serve, and for plain
		* chat models without parameters.
		*/
		function TaskStrip({ t, useFeatures, useTaskInputs, useReferenceVoice, useGate, useVideoProgress, useInput, inputActions, setValue, pickReference, clearReference, setConsent, setReferenceText, startReference, stopReference, keepReference, discardRecordedReference, generate, cancelGenerate, dismissTaskError, loadValues, openLibrary }) {
			const model = useFeatures((features) => features.model);
			const candidates = useFeatures((features) => features.liveCandidates);
			const inputs = useTaskInputs((snapshot) => snapshot);
			const recorder = useReferenceVoice((snapshot) => snapshot);
			const gate = useGate((snapshot) => snapshot);
			const draft = useInput((state) => state.draft);
			const videoJob = useVideoProgress((snapshot) => snapshot);
			const fileInput = (0, react.useRef)(null);
			const latestDraft = (0, react.useRef)(draft);
			latestDraft.current = draft;
			(0, react.useEffect)(() => () => {
				discardRecordedReference();
			}, [discardRecordedReference]);
			const liveViews = candidates.filter((c) => c.available && c.entry.id !== model?.id).map((c) => ({
				candidate: c,
				view: taskView(c.entry)
			}));
			const serverValues = useServerValues([...model === void 0 ? [] : taskView(model).params, ...liveViews.flatMap((l) => l.view.params)].map(valuesFromOf).filter((u) => u !== void 0), loadValues);
			if (model === void 0) return null;
			const view = taskView(model);
			const showsReference = view.input.referenceAudio !== "none";
			const offerOfParam = (v, param) => {
				const url = valuesFromOf(param);
				const choices = url === void 0 ? void 0 : serverValues[url];
				return offerOf(v, param, choices === "failed" ? [] : choices);
			};
			const params = view.input.referenceText === "none" ? view.params : view.params.filter((p) => !REFERENCE_PARAMS.has(p.key));
			const shown = params.filter((p) => rendersControl(offerOfParam(view, p)));
			const notOffered = params.filter((p) => offerOfParam(view, p) === "not-offered");
			const unlistedKeys = params.filter((p) => offerOfParam(view, p) === "unlisted").map((p) => p.key);
			const unknownKeys = params.filter((p) => offerOfParam(view, p) === "unknown").map((p) => p.key);
			const liveOptions = liveViews.map((l) => ({
				...l,
				params: l.view.params.filter((p) => rendersControl(offerOfParam(l.view, p)))
			})).filter((l) => l.params.length > 0);
			const extraSlots = EXTRA_SLOTS.filter((slot) => view.input[slot] !== "none");
			if (view.task === "chat" && shown.length === 0 && !showsReference && liveOptions.length === 0) return null;
			const blocked = gateBlocks(gate);
			const values = inputs.values[model.id] ?? {};
			const hasValue = (param) => {
				const value = values[param.key] ?? param.default;
				return value !== void 0 && value !== "" && !(Array.isArray(value) && value.length === 0);
			};
			const requiredOptionsMissing = shown.filter((p) => offerOfParam(view, p) === "required" && !hasValue(p)).map((p) => p.key);
			const textRequest = TEXT_REQUEST_TASKS.has(view.task);
			const missing = missingInputs(view, {
				text: textRequest ? draft : "n/a",
				hasAudio: true,
				hasReference: inputs.reference !== void 0,
				referenceConsent: inputs.referenceConsent,
				referenceText: inputs.referenceText,
				options: values,
				extraReferences: Object.fromEntries(extraSlots.map((slot) => [slot, {
					present: inputs.references[slot] !== void 0,
					consent: inputs.consents[slot] === true
				}])),
				requiredOptionsMissing
			});
			const choicesOf = (param) => {
				const url = valuesFromOf(param);
				const choices = url === void 0 ? void 0 : serverValues[url];
				return choices === "failed" ? void 0 : choices;
			};
			const onGenerate = async () => {
				const text = latestDraft.current;
				if (await generate(text) && latestDraft.current === text) inputActions.setDraft("");
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: audio_module_css_default.bar,
				"aria-label": t("task.panel"),
				"data-testid": "dsh-voice-capture-task",
				"data-task": view.task,
				"data-task-source": view.source,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: audio_module_css_default.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: audio_module_css_default.taskChip,
								"data-testid": "dsh-voice-capture-task-chip",
								children: t(`task.name.${view.task}`)
							}),
							view.source === "inferred" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: audio_module_css_default.caption,
								children: t("task.inferred")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: audio_module_css_default.caption,
								"data-testid": "dsh-voice-capture-task-output",
								children: outputText(view, t)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }),
							blocked && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: cx(audio_module_css_default.caption, audio_module_css_default.warn),
								role: "status",
								title: gate.source === void 0 ? void 0 : t(gate.source === "library" ? "gate.sourceLibrary" : "gate.sourceAdapter"),
								"data-testid": "dsh-voice-capture-task-gate",
								"data-state": gate.state,
								"data-source": gate.source,
								children: [
									t(`gate.${gate.state}`),
									"detail" in gate && gate.detail !== void 0 ? ` · ${gate.detail}` : "",
									"progress" in gate && gate.progress !== void 0 ? ` · ${Math.round(gate.progress * (gate.progress <= 1 ? 100 : 1))}%` : ""
								]
							}),
							blocked && gate.library === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "ghost",
								onClick: () => {
									openLibrary();
								},
								"data-testid": "dsh-voice-capture-task-open-library",
								children: t("gate.openLibrary")
							})
						]
					}),
					shown.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.row,
						"data-testid": "dsh-voice-capture-task-params",
						"data-params": inputs.params,
						children: shown.map((param) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ParamControl, {
							param,
							offer: offerOfParam(view, param),
							fact: view.options.byKey[param.key],
							choices: choicesOf(param),
							value: values[param.key],
							onChange: (value) => {
								setValue(param.key, value);
							},
							t
						}, param.key))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(OptionStatusNotes, {
						view,
						notOffered,
						unlistedKeys,
						unknownKeys,
						t
					}),
					view.task === "video-generation" && videoJob !== void 0 && (videoJob.model === void 0 || videoJob.model === model.id) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.caption,
						role: "status",
						"data-testid": "dsh-voice-capture-video-progress",
						"data-status": videoJob.status,
						children: t("task.videoProgress", {
							status: videoJob.status,
							progress: videoJob.progress === void 0 ? "" : ` · ${Math.round(videoJob.progress <= 1 ? videoJob.progress * 100 : videoJob.progress)}%`
						})
					}),
					liveOptions.map(({ candidate, params: liveParams, view: liveView }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						className: audio_module_css_default.referenceBox,
						"data-testid": "dsh-voice-capture-live-options",
						"data-model": candidate.model.model,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", {
							className: audio_module_css_default.caption,
							children: t("task.liveOptions", { model: candidate.model.model })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: audio_module_css_default.row,
							children: liveParams.map((param) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ParamControl, {
								param,
								offer: offerOfParam(liveView, param),
								fact: liveView.options.byKey[param.key],
								choices: choicesOf(param),
								value: inputs.values[candidate.model.model]?.[param.key],
								onChange: (value) => {
									setValue(param.key, value, candidate.model.model);
								},
								t
							}, param.key))
						})]
					}, candidate.model.model)),
					inputs.params !== "unset" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(audio_module_css_default.caption, (inputs.params === "failed" || inputs.params === "unsupported") && audio_module_css_default.warn),
						role: "status",
						"data-testid": "dsh-voice-capture-task-params-state",
						"data-state": inputs.params,
						children: inputs.params === "failed" ? t("params.failed", { detail: inputs.paramsDetail ?? "" }) : t(`params.${inputs.params}`)
					}),
					showsReference && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: audio_module_css_default.referenceBox,
						"data-testid": "dsh-voice-capture-reference",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: audio_module_css_default.row,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: audio_module_css_default.title,
										children: view.input.referenceAudio === "required" ? t("reference.titleRequired") : t("reference.titleOptional")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }),
									recorder.phase === "recording" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: audio_module_css_default.recDot,
											"aria-hidden": "true"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: audio_module_css_default.timer,
											children: clockText(recorder.elapsedMs)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											size: "sm",
											variant: "primary",
											icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StopSquareIcon, { size: 14 }),
											onClick: stopReference,
											children: t("action.stop")
										})
									] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											size: "sm",
											variant: "outline",
											icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MicIcon, { size: 14 }),
											onClick: startReference,
											disabled: recorder.phase === "requesting" || recorder.phase === "encoding",
											"data-testid": "dsh-voice-capture-reference-record",
											children: t("reference.record")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											size: "sm",
											variant: "ghost",
											onClick: () => {
												fileInput.current?.click();
											},
											"data-testid": "dsh-voice-capture-reference-file",
											children: t("reference.chooseFile")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											ref: fileInput,
											type: "file",
											accept: "audio/*",
											hidden: true,
											"data-testid": "dsh-voice-capture-reference-input",
											onChange: (event) => {
												const file = event.currentTarget.files?.[0];
												if (file !== void 0) pickReference(file);
												event.currentTarget.value = "";
											}
										})
									] })
								]
							}),
							recorder.phase === "preview" && recorder.clip !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: audio_module_css_default.row,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("audio", {
										className: audio_module_css_default.player,
										controls: true,
										preload: "metadata",
										src: recorder.clip.url,
										"aria-label": t("reference.previewRecorded")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										size: "sm",
										variant: "ghost",
										onClick: discardRecordedReference,
										children: t("action.discard")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										size: "sm",
										variant: "primary",
										onClick: keepReference,
										"data-testid": "dsh-voice-capture-reference-keep",
										children: t("reference.use")
									})
								]
							}),
							recorder.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: cx(audio_module_css_default.caption, audio_module_css_default.warn),
								role: "alert",
								children: t(`error.${recorder.error.code}`)
							}),
							inputs.reference !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: audio_module_css_default.row,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("audio", {
											className: audio_module_css_default.player,
											controls: true,
											preload: "metadata",
											src: inputs.reference.url,
											"aria-label": t("reference.player"),
											"data-testid": "dsh-voice-capture-reference-player"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: audio_module_css_default.caption,
											children: inputs.reference.name
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: audio_module_css_default.iconButton,
											"aria-label": t("reference.clear"),
											onClick: () => {
												clearReference();
											},
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, { size: 14 })
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: audio_module_css_default.toggle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: inputs.referenceConsent,
										onChange: (event) => {
											setConsent(event.currentTarget.checked);
										},
										"data-testid": "dsh-voice-capture-reference-consent"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("reference.consent") })]
								}),
								view.input.referenceText !== "none" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: audio_module_css_default.textInput,
									type: "text",
									value: inputs.referenceText,
									placeholder: view.input.referenceText === "required" ? t("reference.textRequired") : t("reference.textOptional"),
									"aria-label": t("reference.textLabel"),
									onChange: (event) => {
										setReferenceText(event.currentTarget.value);
									},
									"data-testid": "dsh-voice-capture-reference-text"
								})
							] })
						]
					}),
					extraSlots.map((slot) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExtraReference, {
						slot,
						need: view.input[slot],
						note: view.options.byKey[slot]?.raw.join("; ") || void 0,
						clip: inputs.references[slot],
						consent: inputs.consents[slot] === true,
						onPick: (file) => {
							pickReference(file, slot);
						},
						onClear: () => {
							clearReference(slot);
						},
						onConsent: (consent) => {
							setConsent(consent, slot);
						},
						t
					}, slot)),
					inputs.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: cx(audio_module_css_default.row, audio_module_css_default.warn),
						role: "alert",
						"data-testid": "dsh-voice-capture-task-error",
						"data-code": inputs.error.code,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, { size: 14 }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: audio_module_css_default.caption,
								children: [t(`task.error.${inputs.error.code}`), inputs.error.detail === "" ? "" : ` · ${inputs.error.detail}`]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: audio_module_css_default.iconButton,
								"aria-label": t("action.dismiss"),
								onClick: dismissTaskError,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, { size: 14 })
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: audio_module_css_default.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: audio_module_css_default.caption,
								"data-testid": "dsh-voice-capture-task-needs",
								children: missing.length > 0 ? t("task.needs", { items: missing.map((code) => code === "requiredOption" ? t("task.missing.requiredOption", { keys: requiredOptionsMissing.join(", ") }) : t(`task.missing.${code}`)).join(" · ") }) : textRequest ? t("task.readyText") : inputHint(view, t)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }),
							textRequest && (inputs.phase === "sending" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "ghost",
								onClick: cancelGenerate,
								children: t("action.cancelSend")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "primary",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSendOutline16, { size: 14 }),
								disabled: blocked || missing.length > 0,
								onClick: () => {
									onGenerate();
								},
								"data-testid": "dsh-voice-capture-task-generate",
								children: t(`task.action.${view.task === "video-generation" ? "generateVideo" : view.task === "music-generation" || view.task === "sound-generation" ? "generateAudio" : "generateSpeech"}`)
							}))
						]
					})
				]
			});
		}
		function outputText(view, t) {
			if (view.output.video) return t("task.output.video");
			if (view.output.embedding) return t("task.output.embedding");
			if (view.output.segments && !view.output.audio) return view.output.speakers ? t("task.output.speakers") : t("task.output.transcript");
			if (view.speaks) return t("task.output.spoken");
			if (view.output.audio) return view.output.audioCount === "many" ? t("task.output.audioMany") : t("task.output.audio");
			return t("task.output.text");
		}
		function inputHint(view, t) {
			if (view.task === "alignment") return t("task.hint.alignment");
			if (view.live === "transcription") return t("task.hint.liveTranscription");
			if (view.live === "turn") return t("task.hint.liveTurn");
			if (view.live === "text-input") return t("task.hint.textInput");
			if (view.live !== "none") return t("task.hint.liveConversation");
			if (view.input.audio === "required") return t("task.hint.audioRequired");
			if (view.input.audio === "optional") return t("task.hint.audioOptional");
			return t("task.hint.text");
		}
		function ExtraReference({ slot, need, note, clip, consent, onPick, onClear, onConsent, t }) {
			const input = (0, react.useRef)(null);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: audio_module_css_default.referenceBox,
				"data-testid": `dsh-voice-capture-reference-${slot}`,
				"data-need": need,
				title: note,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: audio_module_css_default.row,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: audio_module_css_default.title,
							children: [t(`reference.slot.${slot}`), need === "required" ? ` · ${t("reference.required")}` : ""]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "ghost",
							onClick: () => {
								input.current?.click();
							},
							"data-testid": `dsh-voice-capture-reference-${slot}-file`,
							children: t("reference.chooseFile")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							ref: input,
							type: "file",
							accept: slot === "imageReference" ? "image/png,image/jpeg,image/webp,image/gif,image/bmp" : "audio/*",
							hidden: true,
							"data-testid": `dsh-voice-capture-reference-${slot}-input`,
							onChange: (event) => {
								const file = event.currentTarget.files?.[0];
								if (file !== void 0) onPick(file);
								event.currentTarget.value = "";
							}
						})
					]
				}), clip !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: audio_module_css_default.row,
					children: [
						slot === "imageReference" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							className: audio_module_css_default.thumb,
							src: clip.url,
							alt: t(`reference.slot.${slot}`),
							"data-testid": `dsh-voice-capture-reference-${slot}-preview`
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("audio", {
							className: audio_module_css_default.player,
							controls: true,
							preload: "metadata",
							src: clip.url,
							"aria-label": t(`reference.slot.${slot}`),
							"data-testid": `dsh-voice-capture-reference-${slot}-preview`
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.caption,
							children: clip.name
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: audio_module_css_default.iconButton,
							"aria-label": t("reference.clear"),
							onClick: onClear,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, { size: 14 })
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: audio_module_css_default.toggle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "checkbox",
						checked: consent,
						onChange: (event) => {
							onConsent(event.currentTarget.checked);
						},
						"data-testid": `dsh-voice-capture-reference-${slot}-consent`
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("reference.consent") })]
				})] })]
			});
		}
		/**
		* Option summary under the controls (§K.11): source, conditional requirements, unknown keys, blockers, negatives with
		* their reason and raw text, unlisted keys (collapsed, never called unsupported), catalog notes and dropped fields.
		*/
		function OptionStatusNotes({ view, notOffered, unlistedKeys, unknownKeys, t }) {
			const facts = view.options;
			const conditional = Object.values(facts.byKey).filter((f) => f.active && f.mandatory === "conditional");
			const notes = facts.unmapped.map((n) => n.raw ?? n.option).filter((n) => n !== void 0);
			const notSendable = facts.notSendable.map((n) => n.option ?? n.wireKey).filter((n) => n !== void 0);
			if (notOffered.length === 0 && unlistedKeys.length === 0 && unknownKeys.length === 0 && conditional.length === 0 && facts.blockers.length === 0 && notes.length === 0 && notSendable.length === 0 && facts.inputErrors.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: audio_module_css_default.hiddenParams,
				"data-testid": "dsh-voice-capture-option-status",
				"data-source": facts.source,
				"data-basis": facts.basis,
				"data-unknown": unknownKeys.join(","),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(`option.source.${facts.source}`) }),
					facts.basis === "catalog-map-empty" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [" · ", t("option.basis.catalog-map-empty")] }),
					facts.scope !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [" · ", t("option.scope", { scope: facts.scope })] }),
					facts.blockers.map((blocker, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.warn,
						role: "status",
						"data-testid": "dsh-voice-capture-option-blocker",
						"data-option": blocker.option ?? blocker.wireKey,
						children: t("option.blocker", {
							option: blocker.raw ?? blocker.option ?? blocker.wireKey ?? "",
							reason: blocker.reason ?? blocker.status ?? ""
						})
					}, `blocker-${index}`)),
					conditional.map((fact) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: audio_module_css_default.warn,
						"data-testid": "dsh-voice-capture-option-conditional",
						"data-key": fact.key,
						children: [
							fact.key,
							": ",
							t("option.requiredWhen", { raw: fact.conditions.join("; ") || fact.raw.join("; ") })
						]
					}, fact.key)),
					unknownKeys.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-testid": "dsh-voice-capture-option-unknown",
						children: [
							t("option.unknown"),
							" — ",
							t("option.unknownKeys", { keys: unknownKeys.join(", ") })
						]
					}),
					notOffered.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						"data-testid": "dsh-voice-capture-option-not-offered",
						"data-keys": notOffered.map((p) => p.key).join(","),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("option.notOffered", { count: notOffered.length }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: notOffered.map((param) => {
							const fact = facts.byKey[param.key];
							const obligation = fact?.obligation ?? "rejected";
							const detail = [...fact?.conditions ?? [], ...fact?.raw ?? []];
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								"data-key": param.key,
								"data-obligation": obligation,
								children: [
									param.key,
									": ",
									t(`option.reason.${obligation}`),
									detail.length > 0 ? ` — ${[...new Set(detail)].join("; ")}` : ""
								]
							}, param.key);
						}) })]
					}),
					unlistedKeys.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						"data-testid": "dsh-voice-capture-option-unlisted",
						"data-keys": unlistedKeys.join(","),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("option.unlisted", { count: unlistedKeys.length }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: unlistedKeys.join(", ") })]
					}),
					notSendable.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						"data-testid": "dsh-voice-capture-option-not-sendable",
						children: t("option.notSendable", { options: notSendable.join(", ") })
					}),
					notes.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						"data-testid": "dsh-voice-capture-option-notes",
						children: t("option.notes", { notes: notes.join("; ") })
					}),
					facts.inputErrors.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.warn,
						"data-testid": "dsh-voice-capture-option-input-errors",
						children: t("option.inputErrors", { fields: facts.inputErrors.map((e) => e.field).join(", ") })
					})
				]
			});
		}
		function ParamControl({ param, offer, fact, choices, value, onChange, t }) {
			const baseLabel = param.label ?? (PARAM_LABELS.has(param.key) ? t(`param.label.${param.key}`) : param.key);
			const label = offer === "required" ? `${baseLabel} *` : offer === "offered-restricted" && fact?.restriction !== void 0 ? `${baseLabel} (${fact.restriction})` : baseLabel;
			const title = [
				offer === "required" ? `${t("option.required")} · ${t("option.unverified")}` : offer === "required-conditional" ? `${t("option.requiredWhen", { raw: fact?.conditions.join("; ") ?? "" })} · ${t("option.unverified")}` : offer === "offered-restricted" ? t("option.restricted", { raw: fact?.restriction ?? "" }) : offer === "offered-unverified" ? t("option.unverified") : offer === "offered-configured" ? t("option.configured") : t("option.server"),
				offer === "offered-restricted" ? void 0 : fact?.raw.join("; "),
				fact?.note
			].filter(Boolean).join(" · ");
			const support = offer === "offered-configured" ? "configured" : offer === "offered-server" ? "server" : "catalog";
			const common = {
				"data-param": param.key,
				"data-support": support,
				"data-offer": offer,
				"data-obligation": fact?.obligation,
				"data-mandatory": fact === void 0 ? void 0 : String(fact.mandatory)
			};
			const listId = `dsh-voice-capture-values-${param.key}`;
			switch (param.type) {
				case "enum": {
					const options = [...new Set([...param.values, ...choices ?? []])];
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: audio_module_css_default.param,
						title,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.caption,
							children: label
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
							className: audio_module_css_default.select,
							value: String(value ?? param.default ?? options[0] ?? ""),
							onChange: (event) => {
								onChange(event.currentTarget.value);
							},
							...common,
							children: options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: option,
								children: option
							}, option))
						})]
					});
				}
				case "number":
				case "integer": {
					const integral = param.type === "integer" || param.step !== void 0 && Number.isInteger(param.step);
					const range = param.min !== void 0 || param.max !== void 0 ? ` (${param.min ?? "…"}–${param.max ?? "…"})` : "";
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: audio_module_css_default.param,
						title,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: audio_module_css_default.caption,
							children: [label, range]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: audio_module_css_default.numberInput,
							type: "number",
							min: param.min,
							max: param.max,
							step: param.step ?? (integral ? 1 : "any"),
							value: typeof value === "number" || typeof value === "string" ? String(value) : String(param.default ?? ""),
							onChange: (event) => {
								onChange(event.currentTarget.value === "" ? "" : Number(event.currentTarget.value));
							},
							...common
						})]
					});
				}
				case "boolean": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: audio_module_css_default.toggle,
					title,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "checkbox",
						checked: Boolean(value ?? param.default ?? false),
						onChange: (event) => {
							onChange(event.currentTarget.checked);
						},
						...common
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
				});
				case "list": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: cx(audio_module_css_default.param, audio_module_css_default.paramWide),
					title,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: audio_module_css_default.caption,
						children: label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: audio_module_css_default.textInput,
						type: "text",
						value: Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : (param.default ?? []).join(", "),
						placeholder: t("param.listHint"),
						onChange: (event) => {
							onChange(event.currentTarget.value);
						},
						...common
					})]
				});
				case "object": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: cx(audio_module_css_default.param, audio_module_css_default.paramWide),
					title,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: audio_module_css_default.caption,
						children: label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						className: audio_module_css_default.textInput,
						rows: 2,
						value: typeof value === "string" ? value : value !== void 0 && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : param.default === void 0 ? "" : JSON.stringify(param.default),
						placeholder: t("param.objectHint"),
						onChange: (event) => {
							onChange(event.currentTarget.value);
						},
						...common
					})]
				});
				case "string":
				case "text": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: cx(audio_module_css_default.param, param.type === "text" && audio_module_css_default.paramWide),
					title,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.caption,
							children: label
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: audio_module_css_default.textInput,
							type: "text",
							list: choices === void 0 ? void 0 : listId,
							maxLength: param.maxLength,
							value: typeof value === "string" ? value : String(param.default ?? ""),
							placeholder: t("task.optional"),
							onChange: (event) => {
								onChange(event.currentTarget.value);
							},
							...common,
							"data-values": choices === void 0 ? void 0 : "ready"
						}),
						choices !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("datalist", {
							id: listId,
							children: choices.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", { value: option }, option))
						})
					]
				});
				default: return null;
			}
		}
		//#endregion
		//#region src/client/audio/capabilities.ts
		/**
		* Capability view of the Session's selected model (CONTRACT §2). The document
		* is read from the audio adapter's route; a missing route (404) means no
		* audio adapter is installed and every audio control stays hidden. States are
		* shown as reported — `declared`/`advertised` are never presented as tested.
		*/
		/** States that may be offered to the user (with their evidence label). */
		const OFFERABLE = [
			"declared",
			"advertised",
			"verified"
		];
		/**
		* Derive the per-Session feature view.
		* @param doc - capability document, when loaded.
		* @param routes - route load state.
		* @param selection - selected model.
		* @param error - last load error text.
		* @returns immutable features.
		*/
		function deriveFeatures(doc, routes, selection, error) {
			const route = doc?.routes.find((entry) => entry.provider === selection?.provider);
			const model = route?.models.find((entry) => entry.id === selection?.model);
			const state = (name) => model?.capabilities[name]?.state ?? "unsupported";
			const candidate = (entry) => {
				if (route === void 0) return void 0;
				const view = taskView(entry);
				const textInput = view.live === "text-input";
				if (entry.mode !== "realtime" && view.live === "none" && entry !== model) return void 0;
				const facts = textInput ? entry.capabilities.audioOutputStreaming : entry.capabilities.liveInput;
				const evidence = facts?.state ?? "unsupported";
				const available = OFFERABLE.includes(evidence);
				if (!available && entry.mode !== "realtime") return void 0;
				const kind = view.live === "none" ? view.speaks ? "conversation" : "transcription" : view.live;
				return {
					model: {
						provider: route.provider,
						model: entry.id
					},
					entry,
					kind,
					evidence,
					available,
					detail: facts?.detail
				};
			};
			const listed = model === void 0 || route === void 0 ? [] : [model, ...route.models.filter((entry) => entry !== model && entry.mode === "realtime")].map(candidate).filter((c) => c !== void 0);
			const liveCandidates = [...listed.filter((c) => c.available), ...listed.filter((c) => !c.available)];
			const live = liveCandidates.find((c) => c.available)?.entry;
			const liveCapability = (name) => live?.capabilities[name]?.state ?? "unsupported";
			const liveState = liveCandidates.find((c) => c.available)?.evidence ?? "unsupported";
			return {
				routes,
				configured: doc?.configured ?? false,
				selection,
				model,
				liveOffered: live !== void 0,
				liveModel: live === void 0 || route === void 0 ? void 0 : {
					provider: route.provider,
					model: live.id
				},
				liveEntry: live,
				liveCandidates,
				liveOnly: model?.mode === "realtime",
				liveState,
				bargeInState: liveCapability("bargeIn"),
				fullDuplexState: liveCapability("fullDuplex"),
				audioOutputStreamingState: state("audioOutputStreaming"),
				observedDelivery: model?.capabilities.audioOutputStreaming?.observedDelivery ?? null,
				error
			};
		}
		/** Shared capability document cache with per-Session feature sources. */
		var CapabilityDirectory = class {
			fetchImpl;
			now;
			minRefreshMs;
			doc;
			routes = "unknown";
			error;
			loading;
			loadedAt = 0;
			listeners = /* @__PURE__ */ new Set();
			/**
			* @param fetchImpl - page fetch.
			* @param now - wall clock in ms.
			* @param minRefreshMs - minimum spacing of automatic reloads.
			*/
			constructor(fetchImpl, now = () => Date.now(), minRefreshMs = 1e4) {
				this.fetchImpl = fetchImpl;
				this.now = now;
				this.minRefreshMs = minRefreshMs;
			}
			/**
			* Load or reload the document (reads only; never triggers a server probe).
			* @param force - bypass the refresh spacing.
			* @returns completion.
			*/
			load(force = false) {
				if (this.loading !== void 0) return this.loading;
				if (!force && this.routes !== "unknown" && this.now() - this.loadedAt < this.minRefreshMs) return Promise.resolve();
				if (this.routes === "unknown") this.routes = "loading";
				this.notify();
				this.loading = requestJson(this.fetchImpl, `${ROUTE_PREFIX}/capabilities`).then((doc) => {
					this.doc = doc;
					this.routes = "ready";
					this.error = void 0;
				}, (error) => {
					if (error instanceof AudioRouteError && error.status === 404) {
						this.routes = "absent";
						this.doc = void 0;
					} else {
						this.routes = this.doc === void 0 ? "error" : "ready";
						this.error = error instanceof Error ? error.message : String(error);
					}
				}).finally(() => {
					this.loadedAt = this.now();
					this.loading = void 0;
					this.notify();
				});
				return this.loading;
			}
			/**
			* Feature source for one Session.
			* @param selection - observable model selection (`lastUsed`/`next`).
			* @returns identity-stable observable of {@link AudioFeatures}.
			*/
			featuresFor(selection) {
				let cached;
				let lastChoiceKey;
				const choice = () => {
					const value = selection.getSnapshot();
					const picked = value?.next ?? value?.lastUsed ?? void 0;
					return picked === void 0 || picked === null ? void 0 : {
						provider: picked.provider,
						model: picked.model
					};
				};
				return {
					getSnapshot: () => {
						const current = choice();
						const key = `${this.routes}|${this.loadedAt}|${this.error ?? ""}|${current?.provider ?? ""}/${current?.model ?? ""}`;
						if (cached?.key !== key) cached = {
							key,
							value: deriveFeatures(this.doc, this.routes, current, this.error)
						};
						return cached.value;
					},
					subscribe: (listener) => {
						this.listeners.add(listener);
						const stopSelection = selection.subscribe(() => {
							const current = choice();
							const choiceKey = `${current?.provider ?? ""}/${current?.model ?? ""}`;
							if (choiceKey !== lastChoiceKey) {
								lastChoiceKey = choiceKey;
								this.load();
							}
							listener();
						});
						this.load();
						return () => {
							this.listeners.delete(listener);
							stopSelection();
						};
					}
				};
			}
			notify() {
				for (const listener of [...this.listeners]) listener();
			}
		};
		//#endregion
		//#region src/client/audio/events.ts
		/**
		* Reconnecting subscriber for `GET …/events?sessionId=&after=` (CONTRACT §3).
		* The NDJSON body is read incrementally; the last cursor is resent on
		* reconnect so audio already received is not replayed. Unsubscribing aborts
		* the fetch only; it never cancels generation.
		*/
		/** Retry delays in ms; the last value repeats. */
		const BACKOFF_MS = [
			500,
			1e3,
			2e3,
			5e3,
			1e4
		];
		/**
		* Subscribe to one Session's audio event feed until the returned disposer runs.
		* @param fetchImpl - page fetch.
		* @param sessionId - Session identity.
		* @param handlers - event and state callbacks.
		* @param sleep - delay function (injectable for tests).
		* @returns disposer that aborts the feed.
		*/
		function subscribeAudioEvents(fetchImpl, sessionId, handlers, sleep = abortableSleep) {
			const abort = new AbortController();
			let cursor;
			(async () => {
				let attempt = 0;
				while (!abort.signal.aborted) {
					handlers.onState(attempt === 0 ? "connecting" : "retrying");
					const query = new URLSearchParams({ sessionId });
					if (cursor !== void 0) query.set("after", cursor);
					try {
						const response = await fetchImpl(routeUrl(`${ROUTE_PREFIX}/events?${query.toString()}`), {
							credentials: "include",
							signal: abort.signal,
							headers: { accept: "application/x-ndjson" }
						});
						if (response.status === 404) {
							handlers.onState("absent");
							return;
						}
						if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
						handlers.onState("open");
						attempt = 0;
						const reader = response.body.getReader();
						const decoder = new NdjsonDecoder();
						for (;;) {
							const { value, done } = await reader.read();
							const batch = done ? decoder.end() : decoder.push(value);
							for (const item of batch.values) {
								if (!isRecord(item) || typeof item.type !== "string") continue;
								if (typeof item.cursor === "string") cursor = item.cursor;
								handlers.onEvent(item);
							}
							if (done) break;
						}
					} catch (error) {
						if (abort.signal.aborted) break;
						handlers.onState("retrying", error instanceof Error ? error.message : String(error));
					}
					if (abort.signal.aborted) break;
					const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
					attempt++;
					try {
						await sleep(delay, abort.signal);
					} catch {}
				}
				handlers.onState("closed");
			})();
			return () => {
				abort.abort();
			};
		}
		function abortableSleep(ms, signal) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(resolve, ms);
				signal.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new DOMException("aborted", "AbortError"));
				}, { once: true });
			});
		}
		//#endregion
		//#region src/client/audio/live.ts
		/**
		* Panel kind for the task named by `live/open` (adapter id, or a proposal-era UI id).
		* @param task - opened task.
		* @returns kind, or undefined for an unknown task.
		*/
		function liveKindOf(task) {
			switch (task) {
				case "asr.realtime":
				case "realtime-asr": return "transcription";
				case "duplex": return "conversation";
				case "speech.s2s.realtime": return "turn";
				case "tts.stream-input": return "text-input";
				default: return;
			}
		}
		function serverFacts(value) {
			if (typeof value !== "object" || value === null) return void 0;
			const raw = value;
			const fact = (key) => {
				const entry = raw[key];
				if (typeof entry !== "object" || entry === null || typeof entry.state !== "string") return {};
				return { [key]: {
					state: entry.state,
					...typeof entry.detail === "string" ? { detail: entry.detail } : {},
					...typeof entry.implementationLevel === "string" ? { implementationLevel: entry.implementationLevel } : {}
				} };
			};
			const facts = {
				...fact("liveInput"),
				...fact("fullDuplex"),
				...fact("bargeIn"),
				...fact("sessionResume")
			};
			return Object.keys(facts).length === 0 ? void 0 : facts;
		}
		/** Append a text piece; sentence pieces that arrive without separating whitespace get one space. */
		function joinText(previous, next) {
			if (previous === "" || next === "" || /\s$/.test(previous) || /^\s/.test(next)) return previous + next;
			return /[.!?。！？]$/.test(previous) ? `${previous} ${next}` : previous + next;
		}
		/** PCM16 encodings the UI can produce; the host converts to the wire encoding itself. */
		const PCM16_ENCODINGS = new Set([
			"pcm_s16le",
			"pcm16",
			"s16le"
		]);
		/**
		* Display name of a staged live input: the host's own name, else one derived from the recording (audio) or the text sha.
		* @param input - close result input.
		* @returns file name.
		*/
		function liveInputName(input) {
			if (typeof input.name === "string" && input.name !== "") return input.name;
			if (input.kind === "text") return `live-text-${input.sha256.slice(0, 12)}.txt`;
			return `live-input-${(input.recordingId ?? input.sha256).slice(-12)}.wav`;
		}
		const OUTCOMES = new Set([
			"no-active-response",
			"response-not-active",
			"cancelled",
			"response-already-completed",
			"stale",
			"unconfirmed"
		]);
		const IDLE$1 = {
			phase: "idle",
			liveId: void 0,
			evidence: "unsupported",
			kind: "conversation",
			task: void 0,
			wire: void 0,
			server: void 0,
			model: void 0,
			elapsedMs: 0,
			level: 0,
			framesSent: 0,
			framesAcked: 0,
			bytesSent: 0,
			accepted: 0,
			acceptedWhileCapturing: 0,
			captureStartedAt: void 0,
			firstAcceptedAt: void 0,
			inputEndedAt: void 0,
			responses: [],
			transcript: "",
			turns: [],
			textChunks: 0,
			textDone: false,
			speech: void 0,
			error: void 0,
			reconnecting: false,
			resumes: 0,
			notice: void 0,
			queued: 0,
			maxQueued: 75,
			frameMs: 200,
			log: "none",
			logDetail: void 0,
			control: void 0,
			observed: {},
			inputRejected: 0,
			integrity: void 0,
			words: [],
			textParams: void 0,
			utteranceOpen: false
		};
		/** Frames that may wait for transmission before the client gives up (15 s at 200 ms, ≈ 480 KB). */
		const MAX_QUEUED_FRAMES = 75;
		/** Retries of one frame answered `429 BUFFER_FULL` (100 ms apart). */
		const MAX_BUSY_RETRIES = 30;
		/** How long one request may keep receiving `503 RECONNECTING` before the session is reported failed. */
		const RECONNECT_WAIT_MS = 15e3;
		/** Delay between retries of a request answered `503 RECONNECTING`. */
		const RECONNECT_RETRY_MS = 250;
		/**
		* Convert Float32 samples to PCM s16le bytes.
		* @param samples - mono samples.
		* @returns little-endian bytes.
		*/
		function toPcm16(samples) {
			const bytes = new Uint8Array(samples.length * 2);
			const view = new DataView(bytes.buffer);
			for (let i = 0; i < samples.length; i++) {
				const s = Math.max(-1, Math.min(1, samples[i]));
				view.setInt16(i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
			}
			return bytes;
		}
		async function routeError(response) {
			const text = await response.text().catch(() => "");
			let code = `HTTP_${response.status}`;
			let message = text.slice(0, 200);
			try {
				const parsed = JSON.parse(text);
				code = parsed.error?.code ?? code;
				message = parsed.error?.message ?? message;
			} catch {}
			return new AudioRouteError(response.status, code, message);
		}
		/** One live session at a time per page. */
		var LiveController = class {
			backend;
			fetchImpl;
			micBusy;
			logExchange;
			now;
			snapshot = IDLE$1;
			listeners = /* @__PURE__ */ new Set();
			sessionId;
			capture;
			frame = new Float32Array(0);
			frameFill = 0;
			queue = [];
			seq = 0;
			sending;
			abort;
			meter;
			capturedSamples = 0;
			/** Responses of this connection the host reported cancelled (`live.response status: cancelled`). */
			cancelledResponses = /* @__PURE__ */ new Set();
			/** Newest player position waiting to be acknowledged; a newer position replaces it (one request in flight at a time). */
			ackPending;
			ackDrain;
			/** Highest acknowledged position per `liveId responseId`; the response acknowledged last; responses superseded by a later one. */
			ackedMs = /* @__PURE__ */ new Map();
			ackedResponse;
			retiredResponses = /* @__PURE__ */ new Set();
			lastTextParams;
			sampleRate = 16e3;
			/**
			* @param backend - microphone capture backend.
			* @param fetchImpl - page fetch.
			* @param micBusy - whether the record-and-send controller currently holds the microphone.
			* @param logExchange - admits the closed exchange's staged input to the Session.
			* @param now - client monotonic clock (ms).
			*/
			constructor(backend, fetchImpl, micBusy, logExchange, now = () => performance.now()) {
				this.backend = backend;
				this.fetchImpl = fetchImpl;
				this.micBusy = micBusy;
				this.logExchange = logExchange;
				this.now = now;
			}
			/** Observable for the live panel. */
			source = {
				getSnapshot: () => this.snapshot,
				subscribe: (listener) => {
					this.listeners.add(listener);
					return () => {
						this.listeners.delete(listener);
					};
				}
			};
			/** Whether capture or a live session is active. */
			get active() {
				return this.snapshot.phase === "opening" || this.snapshot.phase === "live" || this.snapshot.phase === "awaiting" || this.snapshot.phase === "closing";
			}
			/** Session that owns the live exchange, if any. */
			get owner() {
				return this.active ? this.sessionId : void 0;
			}
			/**
			* Open a live session and start transmitting capture frames. User action only.
			* @param sessionId - owning Session.
			* @param model - selected provider/model.
			* @param evidence - capability evidence layer shown with the control.
			* @param bargeIn - explicitly request `overlapPolicy: barge_in_on_speech`; otherwise the host default applies
			*   (nightly server VAD rejects `listen_only`, so the UI never sends it).
			* @param kind - panel kind from the live model's task view.
			* @param busy - reports unfinished work on the same server; a reason refuses the open instead of letting it time out.
			*/
			async start(sessionId, model, evidence, bargeIn, kind = "conversation", busy) {
				if (this.active) return;
				if (this.micBusy()) {
					this.set({
						...IDLE$1,
						phase: "error",
						error: {
							code: "MIC_BUSY",
							message: ""
						}
					});
					return;
				}
				this.sessionId = sessionId;
				this.seq = 0;
				this.queue.length = 0;
				this.capturedSamples = 0;
				this.abort = new AbortController();
				this.cancelledResponses.clear();
				this.ackPending = void 0;
				this.ackedMs.clear();
				this.ackedResponse = void 0;
				this.retiredResponses.clear();
				this.lastTextParams = void 0;
				this.set({
					...IDLE$1,
					phase: "opening",
					evidence,
					kind,
					model,
					maxQueued: MAX_QUEUED_FRAMES
				});
				const busyReason = await busy?.();
				if (busyReason !== void 0) {
					this.set({
						...this.snapshot,
						phase: "error",
						error: {
							code: "SERVER_BUSY",
							message: busyReason
						}
					});
					return;
				}
				if (this.snapshot.phase !== "opening") return;
				let opened;
				try {
					opened = await requestJson(this.fetchImpl, `${ROUTE_PREFIX}/live/open`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							sessionId,
							provider: model.provider,
							model: model.model,
							...bargeIn ? { overlapPolicy: "barge_in_on_speech" } : {}
						}),
						signal: this.abort.signal
					});
				} catch (error) {
					this.fail(error);
					return;
				}
				if (this.snapshot.phase !== "opening") {
					await this.post("close", opened.liveId, void 0).catch(() => void 0);
					return;
				}
				const openedKind = liveKindOf(opened.task) ?? (opened.input.encoding === "text" ? "text-input" : this.snapshot.kind === "text-input" ? "conversation" : this.snapshot.kind);
				this.set({
					...this.snapshot,
					liveId: opened.liveId,
					kind: openedKind,
					task: opened.task,
					wire: opened.wire,
					server: serverFacts(opened.capabilities) ?? this.snapshot.server
				});
				if (openedKind === "text-input") {
					if (opened.input.encoding !== "text") {
						await this.post("close", opened.liveId, void 0).catch(() => void 0);
						this.fail(new AudioRouteError(0, "UNSUPPORTED_INPUT", `text session opened with input encoding ${opened.input.encoding}`));
						return;
					}
					this.set({
						...this.snapshot,
						phase: "live",
						captureStartedAt: this.now()
					});
					return;
				}
				const sampleRate = opened.input.sampleRate;
				if (!PCM16_ENCODINGS.has(opened.input.encoding) || sampleRate === void 0 || opened.input.frameMs === void 0) {
					await this.post("close", opened.liveId, void 0).catch(() => void 0);
					this.fail(new AudioRouteError(0, "UNSUPPORTED_INPUT", `live input ${opened.input.encoding} ${sampleRate ?? "?"} Hz is not PCM16`));
					return;
				}
				this.sampleRate = sampleRate;
				this.set({
					...this.snapshot,
					frameMs: opened.input.frameMs
				});
				const frameSamples = Math.max(1, Math.round(sampleRate * opened.input.frameMs / 1e3));
				this.frame = new Float32Array(Math.min(frameSamples, Math.floor((opened.input.maxFrameBytes ?? frameSamples * 2) / 2)));
				this.frameFill = 0;
				try {
					this.capture = await this.backend.open({
						deviceId: "",
						sampleRate,
						onFrames: (chunk) => this.onFrames(chunk),
						onEnded: () => {
							this.endInput();
						}
					});
				} catch (error) {
					await this.post("close", opened.liveId, void 0).catch(() => void 0);
					this.fail(error);
					return;
				}
				if (this.capture.sampleRate !== sampleRate) {
					await this.capture.close();
					this.capture = void 0;
					await this.post("close", opened.liveId, void 0).catch(() => void 0);
					this.fail(new AudioRouteError(0, "RATE_MISMATCH", `capture context did not run at ${sampleRate} Hz`));
					return;
				}
				const startedAt = this.now();
				this.meter = setInterval(() => {
					this.set({
						...this.snapshot,
						elapsedMs: Math.round(this.capturedSamples * 1e3 / this.sampleRate)
					});
				}, 200);
				this.set({
					...this.snapshot,
					phase: "live",
					captureStartedAt: startedAt
				});
			}
			/**
			* Send text to a streamed text-to-speech session (`live/text`, tts.stream-input only).
			* @param text - text chunk ('' with `done` only ends input).
			* @param done - marks the end of the text input.
			* @returns whether the host accepted it.
			*/
			async sendText(text, done = false, params, endSession = done) {
				const liveId = this.snapshot.liveId;
				if (liveId === void 0 || this.snapshot.phase !== "live" || this.snapshot.kind !== "text-input") return false;
				if (text === "" && !done) return false;
				const withParams = params !== void 0 && Object.keys(params).length > 0 && !this.snapshot.utteranceOpen && JSON.stringify(params) !== JSON.stringify(this.lastTextParams);
				try {
					const result = await this.post("text", liveId, {
						...text === "" ? {} : { text },
						...done ? { done: true } : {},
						...withParams ? { params } : {}
					});
					if (withParams) this.lastTextParams = params;
					this.set({
						...this.snapshot,
						textChunks: typeof result?.chunks === "number" ? result.chunks : this.snapshot.textChunks + (text === "" ? 0 : 1),
						utteranceOpen: !done && (this.snapshot.utteranceOpen || text !== ""),
						...withParams ? { textParams: {
							state: "applied",
							params
						} } : {},
						...done && endSession ? {
							textDone: true,
							phase: "awaiting",
							inputEndedAt: this.now()
						} : {}
					});
					return true;
				} catch (error) {
					if (error instanceof AudioRouteError && [
						"UTTERANCE_IN_PROGRESS",
						"INVALID_PARAM",
						"UNKNOWN_PARAM",
						"BAD_REQUEST"
					].includes(error.code)) {
						this.set({
							...this.snapshot,
							textParams: {
								state: "rejected",
								code: error.code,
								message: error.message,
								params: params ?? {}
							}
						});
						return false;
					}
					this.fail(error);
					return false;
				}
			}
			/** Stop capture, send the remaining frame and the input-end marker; the session stays open for responses. */
			async endInput() {
				if (this.snapshot.phase !== "live") return;
				if (this.snapshot.kind === "text-input") {
					if (this.snapshot.utteranceOpen) await this.sendText("", true);
					else this.set({
						...this.snapshot,
						textDone: true,
						phase: "awaiting",
						inputEndedAt: this.now()
					});
					return;
				}
				const liveId = this.snapshot.liveId;
				clearInterval(this.meter);
				await this.capture?.close();
				this.capture = void 0;
				if (this.frameFill > 0) this.enqueue(this.frame.slice(0, this.frameFill));
				this.frameFill = 0;
				this.set({
					...this.snapshot,
					phase: "awaiting",
					inputEndedAt: this.now(),
					level: 0,
					elapsedMs: Math.round(this.capturedSamples * 1e3 / this.sampleRate)
				});
				await this.sending;
				if (this.snapshot.phase !== "awaiting") return;
				await this.post("control", liveId, { type: "commit" }).catch((error) => {
					this.fail(error);
				});
			}
			/**
			* Interrupt (`barge-in`) or cancel the active reply, and track the host's ACK / outcome (§K.10). The panel only calls a
			* reply interrupted after `outcome: cancelled` and the matching `live.response cancelled` of this connection.
			* @param type - `cancel-response` or `barge-in`.
			*/
			async control(type) {
				const liveId = this.snapshot.liveId;
				if (liveId === void 0 || !this.active) return;
				const active = [...this.snapshot.responses].reverse().find((r) => r.status === "created");
				this.set({
					...this.snapshot,
					control: {
						type,
						controlId: void 0,
						sent: void 0,
						targetResponseId: active?.responseId,
						outcome: "pending",
						confirmed: false
					}
				});
				let reply;
				try {
					reply = await this.post("control", liveId, {
						type,
						...active === void 0 ? {} : { responseId: active.responseId }
					});
				} catch (error) {
					if (error instanceof AudioRouteError && (error.code === "LIVE_CLOSED" || error.status === 410)) {
						this.fail(error);
						return;
					}
					this.set({
						...this.snapshot,
						control: {
							...this.snapshot.control,
							outcome: "error",
							reason: error instanceof Error ? error.message : String(error)
						}
					});
					return;
				}
				const current = this.snapshot.control;
				if (current === void 0 || current.type !== type) return;
				const outcome = typeof reply?.outcome === "string" ? reply.outcome : void 0;
				const controlId = typeof reply?.controlId === "string" ? reply.controlId : void 0;
				const replied = outcome === void 0 ? "no-outcome" : outcome === "sent" || outcome === "pending" ? "pending" : OUTCOMES.has(outcome) ? outcome : "unconfirmed";
				const resolvedByFeed = replied === "pending" && current.outcome !== "pending" && controlId !== void 0 && current.controlId === controlId;
				this.applyControl({
					controlId,
					sent: typeof reply?.sent === "boolean" ? reply.sent : void 0,
					targetResponseId: typeof reply?.targetResponseId === "string" ? reply.targetResponseId : current.targetResponseId,
					...resolvedByFeed ? {} : { outcome: replied },
					...typeof reply?.reason === "string" ? { reason: reply.reason } : {}
				});
			}
			applyControl(patch) {
				const current = this.snapshot.control;
				if (current === void 0) return;
				const next = {
					...current,
					...patch
				};
				const confirmed = next.outcome === "cancelled" && next.targetResponseId !== void 0 && this.cancelledResponses.has(next.targetResponseId);
				this.set({
					...this.snapshot,
					control: {
						...next,
						confirmed
					}
				});
			}
			/**
			* Report the real player position of a live response (never estimated from received bytes).
			* @param responseId - live response id (the playback stream id).
			* @param playedMs - played milliseconds from the output clock.
			*/
			playbackAck(responseId, playedMs) {
				const liveId = this.snapshot.liveId;
				if (liveId === void 0 || !this.acksOpen(liveId)) return Promise.resolve();
				this.ackPending = {
					liveId,
					responseId,
					playedMs
				};
				this.ackDrain ??= this.drainAcks();
				return this.ackDrain;
			}
			/** Acknowledgements are sent only while this live session is open (not while closing, closed or replaced). */
			acksOpen(liveId) {
				return this.snapshot.liveId === liveId && (this.snapshot.phase === "live" || this.snapshot.phase === "awaiting");
			}
			async drainAcks() {
				await Promise.resolve();
				try {
					for (let ack = this.nextAck(); ack !== void 0; ack = this.nextAck()) {
						const { liveId, responseId, playedMs } = ack;
						const key = `${liveId} ${responseId}`;
						const response = await this.sendWithRetry(() => this.fetchImpl(routeUrl(`${ROUTE_PREFIX}/live/control?liveId=${encodeURIComponent(liveId)}`), {
							method: "POST",
							credentials: "include",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								type: "playback-ack",
								responseId,
								playedMs
							})
						}), false, () => !this.acksOpen(liveId) || this.ackPending !== void 0);
						if (!(response instanceof Response)) continue;
						await response.body?.cancel().catch(() => void 0);
						this.ackedMs.set(key, Math.max(playedMs, this.ackedMs.get(key) ?? 0));
						if (this.ackedResponse !== void 0 && this.ackedResponse !== key) this.retiredResponses.add(this.ackedResponse);
						this.ackedResponse = key;
					}
				} finally {
					this.ackDrain = void 0;
				}
				if (this.ackPending !== void 0) this.ackDrain ??= this.drainAcks();
			}
			/** Take the queued position unless it is stale: closed or older session, superseded response, or not newer. */
			nextAck() {
				const ack = this.ackPending;
				this.ackPending = void 0;
				if (ack === void 0 || !this.acksOpen(ack.liveId)) return void 0;
				const key = `${ack.liveId} ${ack.responseId}`;
				if (this.retiredResponses.has(key)) return void 0;
				const acked = this.ackedMs.get(key);
				if (acked !== void 0 && ack.playedMs <= acked) return void 0;
				return ack;
			}
			/** Close the live session (ends capture first when still live). */
			async close() {
				const liveId = this.snapshot.liveId;
				if (this.snapshot.phase === "opening") {
					this.abort?.abort();
					this.set({
						...this.snapshot,
						phase: "closed"
					});
					return;
				}
				if (this.snapshot.phase === "live") await this.endInput();
				if (liveId === void 0 || this.snapshot.phase !== "awaiting" && this.snapshot.phase !== "error") return;
				this.set({
					...this.snapshot,
					phase: "closing"
				});
				let result;
				try {
					result = await this.post("close", liveId, void 0);
				} catch (error) {
					if (!(error instanceof AudioRouteError && (error.code === "LIVE_CLOSED" || error.code === "LIVE_NOT_FOUND"))) {
						this.fail(error);
						return;
					}
				}
				this.recordIntegrity(result);
				await this.logResult(result?.input ?? void 0, result?.receipt);
			}
			recordIntegrity(result) {
				const integrity = result?.inputIntegrity;
				if (integrity === void 0 || typeof integrity.framesForwarded !== "number") return;
				this.set({
					...this.snapshot,
					integrity: {
						framesForwarded: integrity.framesForwarded,
						serverRejectedAppends: typeof integrity.serverRejectedAppends === "number" ? integrity.serverRejectedAppends : 0
					}
				});
			}
			async collectClosedResult(liveId) {
				let result;
				try {
					result = await this.post("close", liveId, void 0);
				} catch {
					return;
				}
				await this.logResult(result?.input ?? void 0, result?.receipt);
			}
			async logResult(input, receipt) {
				const sessionId = this.sessionId;
				if (input === void 0 || sessionId === void 0 || typeof input.receiptId !== "string") {
					const detail = this.snapshot.kind === "text-input" ? "text-input" : receipt?.reason === "no-response" ? "no-reply" : receipt?.reason === "no-input" ? "no-input" : receipt?.reason !== void 0 ? [receipt.reason, receipt.detail].filter(Boolean).join(": ") : input === void 0 ? "no-input" : typeof input.stagingError === "string" && input.stagingError !== "" ? input.stagingError : "no-reply";
					this.set({
						...this.snapshot,
						phase: this.snapshot.phase === "closing" ? "closed" : this.snapshot.phase,
						log: "unavailable",
						logDetail: detail
					});
					return;
				}
				this.set({
					...this.snapshot,
					phase: this.snapshot.phase === "closing" ? "closed" : this.snapshot.phase,
					log: "logging"
				});
				const logged = await this.logExchange(sessionId, input).catch((error) => ({
					ok: false,
					detail: String(error)
				}));
				this.set({
					...this.snapshot,
					log: logged.ok ? "logged" : "failed",
					logDetail: logged.ok ? void 0 : logged.detail
				});
			}
			/** Return a closed or failed panel to idle. */
			dismiss() {
				if (this.active) return;
				this.set(IDLE$1);
			}
			/**
			* Apply a feed event (`live.*`, and `text.delta` for this session's responses).
			* @param event - decoded feed event.
			*/
			handleEvent(event) {
				const liveId = this.snapshot.liveId;
				if (liveId === void 0) return;
				if (event.type.startsWith("live.") && event.liveId !== liveId) return;
				switch (event.type) {
					case "live.input.accepted": {
						const at = this.now();
						this.set({
							...this.snapshot,
							accepted: this.snapshot.accepted + 1,
							acceptedWhileCapturing: this.snapshot.acceptedWhileCapturing + (this.snapshot.phase === "live" ? 1 : 0),
							firstAcceptedAt: this.snapshot.firstAcceptedAt ?? at
						});
						return;
					}
					case "live.error":
						if (event.fatal === true) return;
						this.set({
							...this.snapshot,
							notice: `${String(event.code ?? "")} ${String(event.message ?? "")}`.trim()
						});
						return;
					case "live.speech":
						this.set({
							...this.snapshot,
							speech: String(event.event ?? "")
						});
						return;
					case "live.control.result": {
						const control = this.snapshot.control;
						if (control === void 0) return;
						const controlId = typeof event.controlId === "string" ? event.controlId : void 0;
						if (typeof event.control === "string" && event.control !== control.type) return;
						if (control.controlId !== void 0 && controlId !== void 0 && controlId !== control.controlId) return;
						if (control.targetResponseId !== void 0 && typeof event.targetResponseId === "string" && event.targetResponseId !== control.targetResponseId) return;
						const outcome = typeof event.outcome === "string" ? event.outcome : "unconfirmed";
						if (outcome === "sent") return;
						this.applyControl({
							...controlId === void 0 ? {} : { controlId },
							...typeof event.sent === "boolean" ? { sent: event.sent } : {},
							...typeof event.targetResponseId === "string" ? { targetResponseId: event.targetResponseId } : {},
							outcome: OUTCOMES.has(outcome) ? outcome : "unconfirmed",
							...typeof event.reason === "string" ? { reason: event.reason } : {}
						});
						return;
					}
					case "live.capability": {
						if (typeof event.key !== "string" || typeof event.state !== "string") return;
						const observation = {
							key: event.key,
							state: event.state,
							...typeof event.detail === "string" ? { detail: event.detail } : {},
							...typeof event.responseId === "string" ? { responseId: event.responseId } : {},
							...typeof event.implementationLevel === "string" ? { implementationLevel: event.implementationLevel } : {},
							...typeof event.at === "string" ? { at: event.at } : {}
						};
						this.set({
							...this.snapshot,
							observed: {
								...this.snapshot.observed,
								[event.key]: observation
							}
						});
						return;
					}
					case "live.input.rejected":
						this.set({
							...this.snapshot,
							inputRejected: this.snapshot.inputRejected + 1,
							notice: `${String(event.code ?? "rejected")} ${String(event.message ?? "")}`.trim()
						});
						return;
					case "live.words": {
						const state = event.state === "aligned" || event.state === "silence" ? event.state : "failed";
						const words = Array.isArray(event.words) ? event.words.flatMap((w) => {
							const item = w;
							const startMs = Number(item.startMs);
							const endMs = Number(item.endMs);
							return typeof item.word === "string" && Number.isFinite(startMs) && Number.isFinite(endMs) ? [{
								word: item.word,
								startMs,
								endMs
							}] : [];
						}) : [];
						this.set({
							...this.snapshot,
							words: [...this.snapshot.words, {
								responseId: String(event.responseId ?? ""),
								sentenceIndex: typeof event.sentenceIndex === "number" ? event.sentenceIndex : null,
								state,
								words
							}]
						});
						return;
					}
					case "live.response": {
						const responseId = String(event.responseId ?? "");
						const next = {
							responseId,
							status: event.status,
							...typeof event.reason === "string" ? { reason: event.reason } : {}
						};
						const responses = this.snapshot.responses.some((r) => r.responseId === responseId) ? this.snapshot.responses.map((r) => r.responseId === responseId ? next : r) : [...this.snapshot.responses, next];
						if (next.status === "cancelled") this.cancelledResponses.add(responseId);
						this.set({
							...this.snapshot,
							responses
						});
						const control = this.snapshot.control;
						if (control !== void 0 && next.status === "cancelled" && control.targetResponseId === responseId) this.applyControl({});
						return;
					}
					case "text.delta": {
						const responseId = typeof event.responseId === "string" ? event.responseId : String(event.streamId ?? "");
						if (event.liveId !== liveId && !this.snapshot.responses.some((r) => r.responseId === responseId)) return;
						const kind = event.kind === "transcript" || event.kind === void 0 && this.snapshot.kind === "transcription" ? "transcript" : "response";
						this.applyText(responseId, kind, String(event.text ?? ""), false);
						return;
					}
					case "live.transcript.done": {
						const turnId = String(event.responseId ?? event.turnId ?? "");
						const existing = this.snapshot.turns.find((t) => t.id === turnId);
						this.applyText(turnId, existing?.kind ?? (this.snapshot.kind === "transcription" ? "transcript" : "response"), typeof event.text === "string" ? event.text : existing?.text ?? "", true);
						return;
					}
					case "live.state": {
						const state = event.state;
						if (state === "reconnecting") {
							if (this.active) this.set({
								...this.snapshot,
								reconnecting: true
							});
							return;
						}
						if (state === "ready" && event.resumed !== true) {
							const facts = serverFacts(event.capabilities);
							if (facts !== void 0) this.set({
								...this.snapshot,
								server: facts
							});
							return;
						}
						if (state === "ready" && event.resumed === true) {
							const attempts = typeof event.attempts === "number" ? event.attempts : void 0;
							this.set({
								...this.snapshot,
								reconnecting: false,
								resumes: this.snapshot.resumes + 1,
								notice: `resumed${attempts === void 0 ? "" : ` (${attempts})`}`
							});
							return;
						}
						if (state === "closed" || state === "error") {
							clearInterval(this.meter);
							this.capture?.close();
							this.capture = void 0;
							this.queue.length = 0;
							const error = typeof event.error === "object" && event.error !== null ? event.error : void 0;
							const wasActive = this.active && this.snapshot.phase !== "closing";
							this.set({
								...this.snapshot,
								phase: state === "error" ? "error" : "closed",
								level: 0,
								reconnecting: false,
								error: error === void 0 ? this.snapshot.error : {
									code: String(error.code ?? "LIVE_CLOSED"),
									message: String(error.message ?? "")
								}
							});
							if (wasActive && state === "closed") this.collectClosedResult(liveId);
						}
						return;
					}
					default: return;
				}
			}
			applyText(id, kind, text, final) {
				const index = this.snapshot.turns.findIndex((t) => t.id === id);
				const turns = index === -1 ? [...this.snapshot.turns, {
					id,
					kind,
					text,
					final
				}] : this.snapshot.turns.map((t, i) => i === index ? {
					...t,
					text: final ? text : joinText(t.text, text),
					final: t.final || final
				} : t);
				this.set({
					...this.snapshot,
					turns,
					transcript: turns.map((t) => t.text).join(turns.every((t) => t.kind === "transcript") ? " " : "\n").trim()
				});
			}
			/** Release capture and close the session on unload. */
			async dispose() {
				const liveId = this.snapshot.liveId;
				const wasActive = this.active;
				clearInterval(this.meter);
				this.abort?.abort();
				await this.capture?.close();
				this.capture = void 0;
				this.queue.length = 0;
				if (wasActive && liveId !== void 0) await this.post("close", liveId, void 0).catch(() => void 0);
				this.set(IDLE$1);
			}
			onFrames(chunk) {
				if (this.snapshot.phase !== "live") return;
				let power = 0;
				for (let i = 0; i < chunk.length; i++) power += chunk[i] * chunk[i];
				const level = Math.min(1, Math.sqrt(power / Math.max(1, chunk.length)) * 4);
				this.capturedSamples += chunk.length;
				let offset = 0;
				while (offset < chunk.length) {
					const take = Math.min(this.frame.length - this.frameFill, chunk.length - offset);
					this.frame.set(chunk.subarray(offset, offset + take), this.frameFill);
					this.frameFill += take;
					offset += take;
					if (this.frameFill === this.frame.length) {
						this.enqueue(this.frame.slice());
						this.frameFill = 0;
					}
				}
				if (Math.abs(level - this.snapshot.level) > .05) this.set({
					...this.snapshot,
					level
				});
			}
			enqueue(samples) {
				if (this.queue.length >= MAX_QUEUED_FRAMES) {
					this.fail(new AudioRouteError(0, "CLIENT_BACKLOG", `more than ${MAX_QUEUED_FRAMES} frames waiting for the host`));
					return;
				}
				this.queue.push(toPcm16(samples));
				this.set({
					...this.snapshot,
					queued: this.queue.length
				});
				if (this.sending === void 0) this.sending = this.pump().finally(() => {
					this.sending = void 0;
				});
			}
			async pump() {
				while (this.queue.length > 0) {
					const liveId = this.snapshot.liveId;
					if (liveId === void 0 || !this.active) return;
					const body = this.queue[0];
					const seq = this.seq;
					const response = await this.sendWithRetry(() => this.fetchImpl(routeUrl(`${ROUTE_PREFIX}/live/append?liveId=${encodeURIComponent(liveId)}&seq=${seq}`), {
						method: "POST",
						credentials: "include",
						headers: { "content-type": "application/octet-stream" },
						body,
						...this.abort === void 0 ? {} : { signal: this.abort.signal }
					}), true);
					if (response instanceof AudioRouteError || response instanceof Error) {
						this.fail(response);
						return;
					}
					await response.body?.cancel();
					this.queue.shift();
					this.seq = seq + 1;
					this.set({
						...this.snapshot,
						queued: this.queue.length,
						framesSent: this.snapshot.framesSent + 1,
						framesAcked: this.snapshot.framesAcked + 1,
						bytesSent: this.snapshot.bytesSent + body.byteLength
					});
				}
			}
			/**
			* Send one request, repeating the identical request on `429 BUFFER_FULL` (append only) and on
			* `503 RECONNECTING` (bounded by {@link RECONNECT_WAIT_MS}); every other non-2xx answer is returned as an error.
			* @param attempt - issues the request once.
			* @param retryBusy - whether `429` is retryable for this request.
			* @param superseded - checked after each reconnect wait; true drops the request (returns an `Error('superseded')`).
			* @returns the successful response or the terminal error.
			*/
			async sendWithRetry(attempt, retryBusy, superseded) {
				let busyRetries = 0;
				let reconnectSince;
				for (;;) {
					const response = await attempt().catch((error) => error instanceof Error ? error : new Error(String(error)));
					if (response instanceof Error) return response;
					if (response.ok) {
						if (this.snapshot.reconnecting) this.set({
							...this.snapshot,
							reconnecting: false
						});
						return response;
					}
					const failure = await routeError(response);
					if (failure.status === 503 && failure.code === "RECONNECTING" && this.active) {
						const now = Date.now();
						reconnectSince ??= now;
						if (now - reconnectSince < RECONNECT_WAIT_MS) {
							if (!this.snapshot.reconnecting) this.set({
								...this.snapshot,
								reconnecting: true
							});
							await new Promise((resolve) => setTimeout(resolve, RECONNECT_RETRY_MS));
							if (superseded?.() === true) return /* @__PURE__ */ new Error("superseded");
							continue;
						}
					}
					if (retryBusy && failure.status === 429 && busyRetries < MAX_BUSY_RETRIES) {
						busyRetries++;
						await new Promise((resolve) => setTimeout(resolve, 100));
						continue;
					}
					return failure;
				}
			}
			async post(route, liveId, body) {
				const response = await this.sendWithRetry(() => this.fetchImpl(routeUrl(`${ROUTE_PREFIX}/live/${route}?liveId=${encodeURIComponent(liveId)}`), {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body ?? {})
				}), false);
				if (response instanceof Error) throw response;
				const text = await response.text();
				return text === "" ? void 0 : JSON.parse(text);
			}
			fail(error) {
				clearInterval(this.meter);
				this.capture?.close();
				this.capture = void 0;
				this.queue.length = 0;
				const code = error instanceof AudioRouteError ? error.code : error instanceof CaptureError ? error.failure : "LIVE_FAILED";
				const message = error instanceof Error ? error.message : String(error);
				this.set({
					...this.snapshot,
					phase: "error",
					level: 0,
					error: {
						code,
						message
					}
				});
			}
			set(next) {
				this.snapshot = next;
				for (const listener of [...this.listeners]) listener();
			}
		};
		//#endregion
		//#region src/client/audio/player.ts
		const IDLE = {
			phase: "idle",
			streamId: void 0,
			origin: void 0,
			task: void 0,
			hostDelivery: "pending",
			playedBeforeEnd: false,
			chunks: 0,
			droppedChunks: 0,
			gaps: 0,
			epochFlushes: 0,
			sampleRate: 0,
			receivedSeconds: 0,
			firstChunkAt: void 0,
			playbackScheduledAt: void 0,
			endEventAt: void 0,
			status: void 0,
			autoplay: true,
			error: void 0
		};
		/** Output lead time before the first scheduled sample, absorbing decode jitter. */
		const LEAD_SECONDS = .12;
		/**
		* Decode base64 PCM s16le into per-channel Float32 arrays.
		* @param data - base64 payload.
		* @param channels - interleaved channel count.
		* @returns channel arrays.
		*/
		function decodePcm16(data, channels) {
			const binary = atob(data);
			const frames = Math.floor(binary.length / 2 / channels);
			const out = Array.from({ length: channels }, () => new Float32Array(frames));
			for (let frame = 0; frame < frames; frame++) for (let c = 0; c < channels; c++) {
				const offset = (frame * channels + c) * 2;
				let value = binary.charCodeAt(offset) | binary.charCodeAt(offset + 1) << 8;
				if (value >= 32768) value -= 65536;
				out[c][frame] = value / 32768;
			}
			return out;
		}
		/** Per-Session progressive player. */
		var ProgressivePlayer = class {
			createOutput;
			now;
			snapshot = IDLE;
			listeners = /* @__PURE__ */ new Set();
			stream;
			output;
			/**
			* @param createOutput - lazily creates the output on the first scheduled chunk.
			* @param now - client monotonic clock in ms.
			*/
			constructor(createOutput, now = () => performance.now()) {
				this.createOutput = createOutput;
				this.now = now;
			}
			/** Observable source for the reply bar. */
			source = {
				getSnapshot: () => this.snapshot,
				subscribe: (listener) => {
					this.listeners.add(listener);
					return () => {
						this.listeners.delete(listener);
					};
				}
			};
			/**
			* Apply one feed event.
			* @param event - validated playback event.
			*/
			handle(event) {
				switch (event.type) {
					case "audio.start":
						this.flush();
						this.stream = {
							streamId: event.streamId,
							origin: event.origin,
							sampleRate: 0,
							channels: 1,
							epoch: 0,
							anchor: void 0,
							anchorSample: 0,
							handles: /* @__PURE__ */ new Set(),
							stopped: false,
							ended: false
						};
						this.set({
							...IDLE,
							autoplay: this.snapshot.autoplay,
							phase: "receiving",
							streamId: event.streamId,
							origin: event.origin,
							task: typeof event.task === "string" ? event.task : void 0
						});
						return;
					case "audio.format": {
						const stream = this.current(event.streamId);
						if (stream === void 0) return;
						stream.sampleRate = event.sampleRate;
						stream.channels = Math.max(1, event.channels);
						this.set({
							...this.snapshot,
							sampleRate: event.sampleRate
						});
						return;
					}
					case "audio.chunk":
						this.chunk(event);
						return;
					case "audio.epoch": {
						const stream = this.current(event.streamId);
						if (stream === void 0 || event.epoch <= stream.epoch) return;
						stream.epoch = event.epoch;
						this.stopHandles(stream);
						stream.anchor = void 0;
						this.set({
							...this.snapshot,
							epochFlushes: this.snapshot.epochFlushes + 1
						});
						return;
					}
					case "audio.gap": {
						const stream = this.current(event.streamId);
						if (stream === void 0) return;
						if (stream.anchor !== void 0 && this.output !== void 0 && this.output.currentTime > stream.anchor) stream.anchor = void 0;
						this.set({
							...this.snapshot,
							gaps: this.snapshot.gaps + 1
						});
						return;
					}
					case "audio.end": {
						const stream = this.current(event.streamId);
						if (stream === void 0) return;
						stream.ended = true;
						const at = this.now();
						this.set({
							...this.snapshot,
							hostDelivery: event.delivery,
							status: event.status,
							endEventAt: at,
							playedBeforeEnd: this.snapshot.playbackScheduledAt !== void 0 && this.snapshot.chunks >= 2,
							phase: stream.stopped ? "stopped" : event.status === "error" ? "error" : stream.handles.size === 0 ? "ended" : "playing"
						});
						return;
					}
					default: return;
				}
			}
			/**
			* Actual played position of the current stream, from the output clock (not from received bytes).
			* @returns stream id and played milliseconds, or undefined when nothing has been scheduled.
			*/
			playedPosition() {
				const stream = this.stream;
				const output = this.output;
				if (stream === void 0 || output === void 0 || stream.anchor === void 0 || stream.sampleRate <= 0) return void 0;
				const elapsed = output.currentTime - stream.anchor + stream.anchorSample / stream.sampleRate;
				const played = Math.max(0, Math.min(elapsed, this.snapshot.receivedSeconds));
				return {
					streamId: stream.streamId,
					origin: stream.origin,
					playedMs: Math.round(played * 1e3)
				};
			}
			/** Stop audible playback of the current stream; later chunks of it stay silent. */
			stop() {
				const stream = this.stream;
				if (stream === void 0) return;
				stream.stopped = true;
				this.stopHandles(stream);
				this.set({
					...this.snapshot,
					phase: "stopped"
				});
			}
			/**
			* Toggle automatic playback of incoming replies.
			* @param enabled - whether chunks are scheduled audibly.
			*/
			setAutoplay(enabled) {
				if (!enabled) this.stop();
				this.set({
					...this.snapshot,
					autoplay: enabled
				});
			}
			/** Release the output (Session composer closed or plugin unload). */
			async dispose() {
				this.flush();
				const output = this.output;
				this.output = void 0;
				await output?.close();
			}
			chunk(event) {
				const stream = this.current(event.streamId);
				if (stream === void 0) return;
				if (event.epoch < stream.epoch) {
					this.set({
						...this.snapshot,
						droppedChunks: this.snapshot.droppedChunks + 1
					});
					return;
				}
				const at = this.now();
				const firstChunkAt = this.snapshot.firstChunkAt ?? at;
				const received = this.snapshot.receivedSeconds + (stream.sampleRate > 0 ? event.samples / stream.sampleRate : 0);
				if (stream.stopped || !this.snapshot.autoplay || stream.sampleRate <= 0) {
					this.set({
						...this.snapshot,
						chunks: this.snapshot.chunks + 1,
						firstChunkAt,
						receivedSeconds: received
					});
					return;
				}
				let output = this.output;
				if (output === void 0) {
					output = this.createOutput();
					this.output = output;
					output.resume();
				}
				if (stream.anchor === void 0) {
					stream.anchor = output.currentTime + LEAD_SECONDS;
					stream.anchorSample = event.startSample;
				}
				const offset = (event.startSample - stream.anchorSample) / stream.sampleRate;
				let when = stream.anchor + offset;
				if (when < output.currentTime) {
					stream.anchor = output.currentTime + LEAD_SECONDS;
					stream.anchorSample = event.startSample;
					when = stream.anchor;
				}
				const samples = decodePcm16(event.data, stream.channels);
				const handle = output.schedule(samples, stream.sampleRate, when, () => {
					stream.handles.delete(handle);
					if (stream === this.stream && stream.ended && stream.handles.size === 0 && this.snapshot.phase === "playing") this.set({
						...this.snapshot,
						phase: "ended"
					});
				});
				stream.handles.add(handle);
				const scheduledAt = this.snapshot.playbackScheduledAt ?? at + Math.max(0, (when - output.currentTime) * 1e3);
				this.set({
					...this.snapshot,
					phase: stream.ended ? this.snapshot.phase : "playing",
					chunks: this.snapshot.chunks + 1,
					firstChunkAt,
					playbackScheduledAt: scheduledAt,
					receivedSeconds: received
				});
			}
			current(streamId) {
				return this.stream?.streamId === streamId ? this.stream : void 0;
			}
			stopHandles(stream) {
				const handles = [...stream.handles];
				stream.handles.clear();
				for (const handle of handles) handle.stop();
			}
			flush() {
				if (this.stream !== void 0) this.stopHandles(this.stream);
				this.stream = void 0;
			}
			set(next) {
				this.snapshot = next;
				for (const listener of [...this.listeners]) listener();
			}
		};
		/**
		* Web Audio output.
		* @returns an output bound to a new AudioContext.
		*/
		function webAudioOutput() {
			const context = new AudioContext();
			return {
				get currentTime() {
					return context.currentTime;
				},
				schedule(samples, sampleRate, when, onEnded) {
					const buffer = context.createBuffer(samples.length, samples[0]?.length ?? 0, sampleRate);
					samples.forEach((channel, index) => {
						buffer.copyToChannel(channel, index);
					});
					const node = context.createBufferSource();
					node.buffer = buffer;
					node.connect(context.destination);
					let done = false;
					const finish = () => {
						if (done) return;
						done = true;
						node.disconnect();
						onEnded();
					};
					node.onended = finish;
					node.start(Math.max(when, context.currentTime));
					return { stop() {
						try {
							node.stop();
						} catch {}
						finish();
					} };
				},
				resume: () => context.resume(),
				close: () => context.close()
			};
		}
		//#endregion
		//#region src/client/audio/results.ts
		/**
		* Machine-readable task results in assistant messages (TASK_UI_CONTRACT_PROPOSAL.md §E):
		* one fenced `dsh-audio-result` JSON block per result. Parsed from the durable
		* message text, so results survive reload and do not depend on Markdown rendering.
		*/
		const WORD_STATES = new Set([
			"aligned",
			"omitted",
			"missing",
			"invalid"
		]);
		function wordTimestampsOf(value) {
			if (!isRecord(value) || typeof value.state !== "string" || !WORD_STATES.has(value.state)) return void 0;
			const words = Array.isArray(value.words) ? value.words.flatMap((w) => {
				if (!isRecord(w) || typeof w.word !== "string") return [];
				const startMs = Number(w.startMs);
				const endMs = Number(w.endMs);
				return Number.isFinite(startMs) && Number.isFinite(endMs) ? [{
					word: w.word,
					startMs,
					endMs
				}] : [];
			}) : [];
			return {
				state: value.state,
				words
			};
		}
		/** Fenced form (visible as a code block) and HTML-comment form (hidden by the Markdown renderer). */
		const BLOCK = /```dsh-audio-result[ \t]*\r?\n([\s\S]*?)\r?\n```|<!--\s*dsh-audio-result\s+([\s\S]*?)\s*-->/g;
		const ID = /^[A-Za-z0-9._~-]{1,200}$/;
		/**
		* Extract result blocks from assistant text; malformed blocks are skipped.
		* @param text - assistant message text.
		* @param seq - message sequence.
		* @returns parsed results in text order.
		*/
		function parseAudioResults(text, seq) {
			const results = [];
			let index = 0;
			for (const match of text.matchAll(BLOCK)) {
				let value;
				try {
					value = JSON.parse(match[1] ?? match[2]);
				} catch {
					continue;
				}
				if (!isRecord(value) || typeof value.task !== "string") continue;
				const segments = Array.isArray(value.segments) ? value.segments.flatMap((segment) => {
					if (!isRecord(segment) || typeof segment.text !== "string") return [];
					const start = Number(segment.start);
					const end = Number(segment.end);
					if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
					return [{
						start,
						end,
						text: segment.text,
						...typeof segment.speaker === "string" ? { speaker: segment.speaker } : {}
					}];
				}) : [];
				const outputs = Array.isArray(value.outputs) ? value.outputs.flatMap((output) => {
					if (!isRecord(output) || typeof output.recordingId !== "string" || !ID.test(output.recordingId)) return [];
					const track = isRecord(output.audioTrack) && typeof output.audioTrack.present === "boolean" ? output.audioTrack : void 0;
					const num = (value, key) => typeof value === "number" && Number.isFinite(value) ? { [key]: value } : {};
					return [{
						kind: output.kind === "video" ? "video" : "audio",
						role: typeof output.role === "string" ? output.role : "audio",
						...num(output.bytes, "bytes"),
						...num(output.width, "width"),
						...num(output.height, "height"),
						...track === void 0 ? {} : { audioTrack: {
							present: track.present,
							...typeof track.codec === "string" ? { codec: track.codec } : {},
							...num(track.sampleRate, "sampleRate"),
							...num(track.channels, "channels"),
							...num(track.durationSeconds, "durationSeconds"),
							...typeof track.sha256 === "string" ? { sha256: track.sha256 } : {}
						} },
						recordingId: output.recordingId,
						...typeof output.sampleRate === "number" ? { sampleRate: output.sampleRate } : {},
						...typeof output.channels === "number" ? { channels: output.channels } : {},
						...typeof output.durationSeconds === "number" ? { durationSeconds: output.durationSeconds } : {},
						...output.delivery === "progressive" || output.delivery === "final-only" || output.delivery === "none" ? { delivery: output.delivery } : {},
						...typeof output.sha256 === "string" && /^[0-9a-f]{64}$/.test(output.sha256) ? { sha256: output.sha256 } : {}
					}];
				}) : [];
				const embedding = isRecord(value.embedding) && typeof value.embedding.resultId === "string" && ID.test(value.embedding.resultId) ? {
					dims: Number(value.embedding.dims) || 0,
					resultId: value.embedding.resultId
				} : void 0;
				results.push({
					seq,
					index: index++,
					task: value.task,
					...typeof value.model === "string" ? { model: value.model } : {},
					...typeof value.language === "string" ? { language: value.language } : {},
					...typeof value.durationSeconds === "number" ? { durationSeconds: value.durationSeconds } : {},
					...typeof value.text === "string" ? { text: value.text } : {},
					segments,
					outputs,
					...embedding === void 0 ? {} : { embedding },
					...typeof value.resultId === "string" && ID.test(value.resultId) ? { resultId: value.resultId } : {},
					...wordTimestampsOf(value.wordTimestamps) === void 0 ? {} : { wordTimestamps: wordTimestampsOf(value.wordTimestamps) },
					...isRecord(value.params) ? { params: value.params } : {}
				});
			}
			return results;
		}
		/**
		* Parse one stored result document (the JSON object of a result block).
		* @param value - decoded JSON.
		* @param seq - linking message sequence.
		* @returns the result, or undefined when malformed.
		*/
		function parseResultDocument(value, seq) {
			return parseAudioResults("```dsh-audio-result\n" + JSON.stringify(value) + "\n```", seq)[0];
		}
		function clock(seconds, separator) {
			const ms = Math.max(0, Math.round(seconds * 1e3));
			const h = Math.floor(ms / 36e5);
			const m = Math.floor(ms % 36e5 / 6e4);
			const s = Math.floor(ms % 6e4 / 1e3);
			const rest = ms % 1e3;
			const pad = (n, w = 2) => String(n).padStart(w, "0");
			return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(rest, 3)}`;
		}
		/**
		* SubRip subtitles.
		* @param segments - transcript segments.
		* @returns SRT text.
		*/
		function toSrt(segments) {
			return segments.map((segment, i) => `${i + 1}\n${clock(segment.start, ",")} --> ${clock(segment.end, ",")}\n${segment.speaker === void 0 ? "" : `[${segment.speaker}] `}${segment.text}\n`).join("\n");
		}
		/**
		* WebVTT subtitles.
		* @param segments - transcript segments.
		* @returns VTT text.
		*/
		function toVtt(segments) {
			return `WEBVTT\n\n${segments.map((segment) => `${clock(segment.start, ".")} --> ${clock(segment.end, ".")}\n${segment.speaker === void 0 ? "" : `<v ${segment.speaker}>`}${segment.text}\n`).join("\n")}`;
		}
		/**
		* Plain transcript with optional speaker labels.
		* @param segments - transcript segments.
		* @returns text lines.
		*/
		function toPlainText(segments) {
			return segments.map((segment) => `${segment.speaker === void 0 ? "" : `${segment.speaker}: `}${segment.text}`).join("\n");
		}
		/**
		* Label key for a generated output role and task.
		* @param task - result task.
		* @param role - output role.
		* @returns locale key suffix.
		*/
		function outputLabel(task, role) {
			if (role.startsWith("stem:")) return "stem";
			if (task === "omni-chat" || task === "s2s" || task === "duplex") return "speechReply";
			if (task === "tts" || task === "voice-clone" || role === "speech") return "generatedSpeech";
			if (task === "music-generation" || role === "music") return "generatedMusic";
			if (task === "sound-generation" || role === "sound") return "generatedSound";
			if (task === "enhancement" || role === "enhanced") return "enhancedAudio";
			if (task === "audio-edit") return "editedAudio";
			return "audio";
		}
		//#endregion
		//#region src/client/audio/recordings.ts
		const RESULT_LINK = new RegExp(`\\[([^\\]\\n]{0,200})\\]\\((?:${ROUTE_PREFIX.replace(/\//g, "\\/")}\\/result\\?id=([A-Za-z0-9._~-]{1,200}))\\)`, "g");
		/**
		* Extract structured-result links (proposal §E) from assistant text.
		* @param text - assistant message text.
		* @param seq - message sequence.
		* @returns links in text order, de-duplicated by result id.
		*/
		function resultLinks(text, seq) {
			const found = /* @__PURE__ */ new Map();
			for (const match of text.matchAll(RESULT_LINK)) if (!found.has(match[2])) found.set(match[2], {
				seq,
				resultId: match[2],
				label: match[1].trim()
			});
			return [...found.values()];
		}
		const LINK = new RegExp(`\\[([^\\]\\n]{0,200})\\]\\((${ROUTE_PREFIX.replace(/\//g, "\\/")}\\/recording\\?id=([A-Za-z0-9._~-]{1,200}))\\)`, "g");
		/**
		* Extract recording links from assistant text.
		* @param text - assistant message text.
		* @param seq - message sequence.
		* @returns links in text order, de-duplicated by recording id.
		*/
		function recordingLinks(text, seq) {
			const found = /* @__PURE__ */ new Map();
			for (const match of text.matchAll(LINK)) {
				const recordingId = match[3];
				if (!found.has(recordingId)) found.set(recordingId, {
					seq,
					recordingId,
					path: match[2],
					label: match[1].trim()
				});
			}
			return [...found.values()];
		}
		function messageText(data) {
			if (!isRecord(data) || !isRecord(data.message) || !Array.isArray(data.message.content)) return "";
			return data.message.content.map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("\n");
		}
		/** Turn-local accumulator; it publishes Turn data and no view Node. */
		const voiceAudioDefinition = {
			kind: "voiceAudio",
			match: (event) => {
				if (event.type === "turn/start") return {
					id: String(event.data.turn),
					role: "start"
				};
				if (event.type === "assistant/message") return {
					id: String(event.data.turn),
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "turn/start") throw new Error("voice-audio start requires turn/start");
				return {
					turn: match.event.data.turn,
					recordings: [],
					results: [],
					resultLinks: []
				};
			},
			update: (context, match) => {
				if (match.event.type !== "assistant/message") return context.state;
				const text = messageText(match.event.data);
				const links = recordingLinks(text, match.event.seq);
				const parsed = parseAudioResults(text, match.event.seq);
				const linked = resultLinks(text, match.event.seq);
				if (links.length === 0 && parsed.length === 0 && linked.length === 0) return context.state;
				const known = new Set(context.state.recordings.map((recording) => recording.recordingId));
				const added = links.filter((link) => !known.has(link.recordingId));
				const knownResults = new Set(context.state.results.map((result) => `${result.seq}:${result.index}`));
				const addedResults = parsed.filter((result) => !knownResults.has(`${result.seq}:${result.index}`));
				const knownLinks = new Set(context.state.resultLinks.map((link) => link.resultId));
				const addedLinks = linked.filter((link) => !knownLinks.has(link.resultId));
				if (added.length === 0 && addedResults.length === 0 && addedLinks.length === 0) return context.state;
				return {
					...context.state,
					resultLinks: addedLinks.length === 0 ? context.state.resultLinks : [...context.state.resultLinks, ...addedLinks],
					recordings: added.length === 0 ? context.state.recordings : [...context.state.recordings, ...added],
					results: addedResults.length === 0 ? context.state.results : [...context.state.results, ...addedResults]
				};
			},
			buildLocationData: (context, scope, previous) => {
				const state = context.state;
				if (scope !== "turn" || state === void 0 || state.recordings.length === 0 && state.results.length === 0 && state.resultLinks.length === 0) return null;
				if (previous?.kind === "turn" && previous.turn === state.turn && previous.key === "voiceAudio" && previous.value.recordings === state.recordings && previous.value.results === state.results && previous.value.resultLinks === state.resultLinks) return previous;
				return {
					kind: "turn",
					turn: state.turn,
					key: "voiceAudio",
					value: {
						recordings: state.recordings,
						results: state.results,
						resultLinks: state.resultLinks
					}
				};
			}
		};
		/**
		* Chain selector for the completed-Turn tail: results and recordings at or before the closing message.
		* @param owner - closing Turn and sequence.
		* @returns matched content, or null so other tail entries may render.
		*/
		function selectReplyRecordings(owner) {
			const data = owner.turn.data.get("voiceAudio");
			const results = data?.results.filter((result) => result.seq <= owner.seq) ?? [];
			const links = data?.resultLinks.filter((link) => link.seq <= owner.seq) ?? [];
			const covered = new Set(results.flatMap((result) => result.outputs.map((output) => output.recordingId)));
			const linkedSeqs = new Set(links.map((link) => link.seq));
			const recordings = data?.recordings.filter((recording) => recording.seq <= owner.seq && !covered.has(recording.recordingId) && !linkedSeqs.has(recording.seq)) ?? [];
			return results.length === 0 && links.length === 0 && recordings.length === 0 ? null : {
				results,
				resultLinks: links,
				recordings
			};
		}
		//#endregion
		//#region src/client/audio/download.ts
		/** Browser-side file saving shared by result cards. */
		/**
		* Save a Blob under a file name through a temporary object URL.
		* @param blob - content.
		* @param name - suggested file name.
		*/
		function saveBlob(blob, name) {
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = name;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			setTimeout(() => {
				URL.revokeObjectURL(url);
			}, 1e4);
		}
		/**
		* Fetch an authenticated route and save the response body.
		* @param url - absolute same-origin URL.
		* @param name - suggested file name.
		* @returns whether the download succeeded.
		*/
		async function saveRoute(url, name) {
			try {
				const response = await fetch(url, { credentials: "include" });
				if (!response.ok) return false;
				saveBlob(await response.blob(), name);
				return true;
			} catch {
				return false;
			}
		}
		//#endregion
		//#region src/client/audio/AudioReplies.tsx
		/** Completed-Turn audio results: transcripts, generated audio, stems, embeddings and linked recordings (CONTRACT §4, proposal §E). */
		function AudioReplies({ matched, t, loadResult }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: audio_module_css_default.replies,
				"data-testid": "dsh-voice-capture-replies",
				children: [
					matched.resultLinks.map((link) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LinkedResult, {
						link,
						load: loadResult,
						t
					}, link.resultId)),
					matched.results.map((result) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ResultCard, {
						result,
						t
					}, `${result.seq}:${result.index}`)),
					matched.recordings.map((recording) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RecordingPlayer, {
						recordingId: recording.recordingId,
						path: recording.path,
						title: t("reply.audioOutput"),
						caption: recording.label.replace(/^▶\s*/, ""),
						t
					}, recording.recordingId))
				]
			});
		}
		function LinkedResult({ link, load, t }) {
			const [state, setState] = (0, react.useState)({ phase: "loading" });
			(0, react.useEffect)(() => {
				let current = true;
				load(link.resultId, link.seq).then((result) => {
					if (current) setState(result === void 0 ? { phase: "failed" } : {
						phase: "ready",
						result
					});
				}, () => {
					if (current) setState({ phase: "failed" });
				});
				return () => {
					current = false;
				};
			}, [
				link.resultId,
				link.seq,
				load
			]);
			if (state.phase === "ready") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ResultCard, {
				result: state.result,
				t
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: audio_module_css_default.reply,
				"data-testid": "dsh-voice-capture-result-link",
				"data-phase": state.phase,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: audio_module_css_default.replyHead,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: audio_module_css_default.replyTitle,
						children: link.label === "" ? t("result.audio") : link.label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: state.phase === "failed" ? audio_module_css_default.errorText : audio_module_css_default.caption,
						children: state.phase === "failed" ? t("result.unavailable") : t("result.loading")
					})]
				})
			});
		}
		function ResultCard({ result, t }) {
			const hasTranscript = result.segments.length > 0 || result.text !== void 0 && result.text !== "";
			const transcriptTitle = result.task === "translation" ? t("result.translation") : result.task === "diarization" ? t("result.speakers") : t("result.transcript");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: audio_module_css_default.resultGroup,
				"data-testid": "dsh-voice-capture-result",
				"data-task": result.task,
				children: [
					hasTranscript && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TranscriptCard, {
						result,
						title: transcriptTitle,
						t
					}),
					result.outputs.map((output, index) => output.kind === "video" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(VideoPlayer, {
						output,
						t
					}, output.recordingId) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RecordingPlayer, {
						recordingId: output.recordingId,
						path: `${ROUTE_PREFIX}/recording?id=${encodeURIComponent(output.recordingId)}`,
						title: titleFor(result.task, output, index, t),
						caption: outputCaption(output, t),
						t
					}, output.recordingId)),
					result.wordTimestamps !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WordTimestampsCard, {
						words: result.wordTimestamps,
						base: `words-${result.seq}-${result.index}`,
						t
					}),
					result.embedding !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.reply,
						"data-testid": "dsh-voice-capture-embedding",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: audio_module_css_default.replyHead,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: audio_module_css_default.replyTitle,
									children: t("result.embedding")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: audio_module_css_default.caption,
									children: t("result.dims", { dims: result.embedding.dims })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DownloadRoute, {
									url: routeUrl(`/api/dsh-dgx-audio/v1/result?id=${encodeURIComponent(result.embedding.resultId)}`),
									name: `embedding-${result.embedding.resultId.slice(-12)}.json`,
									label: t("result.downloadJson"),
									t
								})
							]
						})
					})
				]
			});
		}
		/** Longest word list rendered inline; the JSON download always has every word. */
		const MAX_WORDS_SHOWN = 200;
		function WordTimestampsCard({ words, base, t }) {
			const aligned = words.state === "aligned";
			const seconds = (ms) => (ms / 1e3).toFixed(2);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: audio_module_css_default.reply,
				"data-testid": "dsh-voice-capture-word-timestamps",
				"data-state": words.state,
				"data-words": words.words.length,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: audio_module_css_default.replyHead,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.replyTitle,
							children: t("result.wordTimestamps")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.caption,
							children: aligned ? t("result.wordCount", { count: words.words.length }) : t(`result.words.${words.state}`)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }),
						aligned && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "ghost",
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, { size: 14 }),
							onClick: () => {
								saveBlob(new Blob([JSON.stringify(words.words, null, 2)], { type: "application/json" }), `${base}.json`);
							},
							children: "JSON"
						})
					]
				}), aligned && words.words.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
					className: audio_module_css_default.wordList,
					children: words.words.slice(0, MAX_WORDS_SHOWN).map((word, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: audio_module_css_default.word,
						title: `${seconds(word.startMs)}–${seconds(word.endMs)} s`,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: word.word }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.caption,
							children: seconds(word.startMs)
						})]
					}, index))
				})]
			});
		}
		function titleFor(task, output, index, t) {
			const kind = outputLabel(task, output.role);
			if (kind === "stem") return t("result.stem", { name: output.role.slice(5) || String(index + 1) });
			return t(`result.${kind}`);
		}
		function outputCaption(output, t) {
			return [
				output.sampleRate === void 0 ? "" : `${output.sampleRate} Hz`,
				output.channels === void 0 ? "" : `${output.channels} ch`,
				output.durationSeconds === void 0 ? "" : clockText(output.durationSeconds * 1e3),
				t === void 0 || output.delivery === void 0 ? "" : output.delivery === "progressive" ? t("result.deliveryProgressive") : output.delivery === "final-only" ? t("result.deliveryFinal") : ""
			].filter(Boolean).join(" · ");
		}
		function TranscriptCard({ result, title, t }) {
			const [copied, setCopied] = (0, react.useState)(false);
			const plain = result.segments.length > 0 ? toPlainText(result.segments) : result.text ?? "";
			const base = `transcript-${result.seq}-${result.index}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: audio_module_css_default.reply,
				"data-testid": "dsh-voice-capture-transcript",
				"data-segments": result.segments.length,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: audio_module_css_default.replyHead,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.replyTitle,
							children: title
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.caption,
							children: [
								result.language,
								result.durationSeconds === void 0 ? void 0 : clockText(result.durationSeconds * 1e3),
								result.model
							].filter(Boolean).join(" · ")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "ghost",
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, { size: 14 }),
							onClick: () => {
								(0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(plain).then((ok) => {
									setCopied(ok);
								});
							},
							children: copied ? t("result.copied") : t("result.copy")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "ghost",
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, { size: 14 }),
							onClick: () => {
								saveBlob(new Blob([plain], { type: "text/plain" }), `${base}.txt`);
							},
							children: "TXT"
						}),
						result.segments.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "ghost",
								onClick: () => {
									saveBlob(new Blob([toSrt(result.segments)], { type: "application/x-subrip" }), `${base}.srt`);
								},
								"data-testid": "dsh-voice-capture-transcript-srt",
								children: "SRT"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "ghost",
								onClick: () => {
									saveBlob(new Blob([toVtt(result.segments)], { type: "text/vtt" }), `${base}.vtt`);
								},
								children: "VTT"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "ghost",
								onClick: () => {
									saveBlob(new Blob([JSON.stringify(result.segments, null, 2)], { type: "application/json" }), `${base}.json`);
								},
								children: "JSON"
							})
						] })
					]
				}), result.segments.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
					className: audio_module_css_default.segments,
					children: result.segments.map((segment, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: audio_module_css_default.segment,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: audio_module_css_default.segmentTime,
								children: [
									segmentTime(segment.start),
									"–",
									segmentTime(segment.end)
								]
							}),
							segment.speaker !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: audio_module_css_default.speaker,
								children: segment.speaker
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: audio_module_css_default.segmentText,
								children: segment.text
							})
						]
					}, index))
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: audio_module_css_default.transcriptText,
					children: plain
				})]
			});
		}
		/** Transcript timestamp with tenths of a second (`m:ss.s`). */
		function segmentTime(seconds) {
			const tenths = Math.max(0, Math.round(seconds * 10));
			const minutes = Math.floor(tenths / 600);
			return `${minutes}:${((tenths - minutes * 600) / 10).toFixed(1).padStart(4, "0")}`;
		}
		function DownloadRoute({ url, name, label, t }) {
			const [state, setState] = (0, react.useState)("idle");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, { size: 14 }),
				disabled: state !== "idle",
				onClick: () => {
					setState("busy");
					saveRoute(url, name).then((ok) => {
						setState(ok ? "idle" : "failed");
					});
				},
				children: state === "busy" ? t("reply.downloading") : state === "failed" ? t("reply.unavailableShort") : label ?? t("reply.download")
			});
		}
		/** Generated video with the host's sound-track facts; the sound track is inside the MP4 (no separate audio stream). */
		function VideoPlayer({ output, t }) {
			const [failed, setFailed] = (0, react.useState)(false);
			const url = routeUrl(`${ROUTE_PREFIX}/recording?id=${encodeURIComponent(output.recordingId)}`);
			const track = output.audioTrack;
			const caption = [
				output.width !== void 0 && output.height !== void 0 ? `${output.width}×${output.height}` : "",
				output.durationSeconds === void 0 ? "" : clockText(output.durationSeconds * 1e3),
				output.delivery === "final-only" ? t("result.deliveryFinal") : ""
			].filter(Boolean).join(" · ");
			const trackText = track === void 0 ? t("result.video.trackUnknown") : track.present ? t("result.video.track", { details: [
				track.codec,
				track.sampleRate === void 0 ? "" : `${track.sampleRate} Hz`,
				track.channels === void 0 ? "" : `${track.channels} ch`,
				track.durationSeconds === void 0 ? "" : clockText(track.durationSeconds * 1e3)
			].filter(Boolean).join(" · ") }) : t("result.video.noTrack");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: audio_module_css_default.reply,
				"data-recording-id": output.recordingId,
				"data-testid": "dsh-voice-capture-video",
				"data-audio-track": track === void 0 ? "unknown" : String(track.present),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: audio_module_css_default.replyHead,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: audio_module_css_default.replyTitle,
								children: t("result.video.title")
							}),
							caption !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: audio_module_css_default.caption,
								children: caption
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }),
							!failed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DownloadRoute, {
								url,
								name: `video-${output.recordingId.slice(-16)}.mp4`,
								t
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(audio_module_css_default.caption, track !== void 0 && !track.present && audio_module_css_default.warn),
						"data-testid": "dsh-voice-capture-video-track",
						children: trackText
					}),
					failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.errorText,
						role: "status",
						children: t("reply.unavailable")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("video", {
						className: audio_module_css_default.video,
						controls: true,
						preload: "metadata",
						src: url,
						onError: () => {
							setFailed(true);
						},
						"data-testid": "dsh-voice-capture-video-player"
					})
				]
			});
		}
		function RecordingPlayer({ recordingId, path, title, caption, t }) {
			const [failed, setFailed] = (0, react.useState)(false);
			const url = routeUrl(path);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: audio_module_css_default.reply,
				"data-recording-id": recordingId,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: audio_module_css_default.replyHead,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.replyTitle,
							children: title
						}),
						caption !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.caption,
							children: caption
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }),
						!failed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DownloadRoute, {
							url,
							name: `audio-${recordingId.slice(-16)}.wav`,
							t
						})
					]
				}), failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: audio_module_css_default.errorText,
					role: "status",
					children: t("reply.unavailable")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("audio", {
					className: audio_module_css_default.player,
					controls: true,
					preload: "metadata",
					src: url,
					"aria-label": t("reply.player"),
					onError: () => {
						setFailed(true);
					},
					"data-testid": "dsh-voice-capture-reply-player"
				})]
			});
		}
		//#endregion
		//#region src/client/audio/LiveButton.tsx
		const START_LABEL = {
			"conversation": "live.start",
			"transcription": "live.startTranscribe",
			"turn": "live.startTurn",
			"text-input": "live.startSpeak"
		};
		const START_TITLE = {
			"conversation": "live.startTitle",
			"transcription": "live.startTranscribeTitle",
			"turn": "live.startTurnTitle",
			"text-input": "live.startSpeakTitle"
		};
		/**
		* Explicit Live-mode entry, shown only when a live session of the selected
		* model's adapter route is declared, advertised or verified; the tooltip
		* carries the evidence layer so an untested mode is never presented as
		* working. With several live models (transcription, duplex, voice turns,
		* streamed speech) the button opens a chooser; cold or loading models are
		* listed but cannot be started.
		*/
		function LiveButton({ t, useFeatures, useLive, useSession, useLiveGates, startLive }) {
			const candidates = useFeatures((features) => features.liveCandidates);
			const gates = useLiveGates((snapshot) => snapshot);
			const phase = useLive((live) => live.phase);
			const subagent = useSession((snapshot) => snapshot.subagent !== null);
			const running = useSession((snapshot) => snapshot.running);
			const [open, setOpen] = (0, react.useState)(false);
			const first = candidates[0];
			if (first === void 0) return null;
			const active = phase === "opening" || phase === "live" || phase === "awaiting" || phase === "closing";
			/** Why a candidate cannot start now; untested, unsupported, cold/busy and a running reply stay distinguishable. */
			const reasonOf = (candidate) => {
				if (!candidate.available) return candidate.evidence === "untested" ? t("live.unavailable.untested", { model: candidate.model.model }) : t("live.unavailable.unsupported", {
					model: candidate.model.model,
					detail: candidate.detail === void 0 ? "" : `: ${candidate.detail}`
				});
				const gate = gates[candidate.model.model];
				if (gate !== void 0 && gateBlocks(gate)) return t("live.gated", { reason: t(`gate.${gate.state}`) });
				if (running) return t("live.replyRunning");
			};
			const choose = candidates.length > 1;
			const firstReason = reasonOf(first);
			const evidenceText = (candidate) => candidate.kind === "text-input" ? t(`evidence.${candidate.evidence}`) : t(`live.input.${candidate.evidence}`);
			const base = choose ? t("live.chooseTitle") : t(START_TITLE[first.kind], { evidence: evidenceText(first) });
			const label = !choose && firstReason !== void 0 ? `${base} — ${firstReason}` : base;
			const button = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: cx(audio_module_css_default.liveButton, active && audio_module_css_default.liveActive, !choose && first.evidence !== "verified" && audio_module_css_default.unverified),
				"aria-label": label,
				"aria-pressed": active,
				"aria-haspopup": choose ? "menu" : void 0,
				disabled: active || subagent || !choose && firstReason !== void 0,
				onMouseDown: (event) => {
					event.preventDefault();
				},
				onClick: () => {
					if (choose) setOpen((value) => !value);
					else startLive(first.model.model);
				},
				"data-testid": "dsh-voice-capture-live",
				"data-evidence": first.evidence,
				"data-kind": choose ? "choose" : first.kind,
				"data-candidates": candidates.length,
				"data-reason": choose ? void 0 : firstReason === void 0 ? void 0 : !first.available ? first.evidence : running ? "reply-running" : "gate",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: audio_module_css_default.liveDot,
					"aria-hidden": "true"
				}), choose ? t("live.start") : t(START_LABEL[first.kind])]
			});
			if (!choose) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label,
				side: "top",
				delayMs: 300,
				maxWidth: 320,
				children: button
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
				open: open && !active,
				anchor: button,
				side: "top",
				portal: true,
				onClose: () => {
					setOpen(false);
				},
				onSelect: (id) => {
					setOpen(false);
					const picked = candidates.find((c) => c.model.model === id);
					if (picked !== void 0 && reasonOf(picked) === void 0) startLive(id);
				},
				items: [{
					type: "label",
					id: "title",
					text: t("live.chooseTitle")
				}, ...candidates.map((candidate) => {
					const reason = reasonOf(candidate);
					return {
						id: candidate.model.model,
						disabled: reason !== void 0,
						label: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: audio_module_css_default.liveChoice,
							"data-testid": "dsh-voice-capture-live-choice",
							"data-model": candidate.model.model,
							"data-kind": candidate.kind,
							"data-evidence": candidate.evidence,
							"data-available": candidate.available,
							"data-blocked": reason === void 0 ? void 0 : "true",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(`live.kind.${candidate.kind}`) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: cx(audio_module_css_default.caption, audio_module_css_default.truncate),
									children: [
										candidate.model.model,
										" · ",
										evidenceText(candidate)
									]
								}),
								reason !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: cx(audio_module_css_default.caption, audio_module_css_default.warn),
									children: reason
								})
							]
						})
					};
				})]
			});
		}
		//#endregion
		//#region src/client/audio/LiveDock.tsx
		const ENDED_CODES = new Set([
			"IDLE_TIMEOUT",
			"RESYNC_REQUIRED",
			"RESUME_REJECTED",
			"BACKEND_DISCONNECTED"
		]);
		/** Seconds without any reply after input ended before the panel says so. */
		const NO_REPLY_HINT_MS = 15e3;
		/**
		* Live panel: transmission state, buffering while connecting, server
		* acknowledgements, live text, responses and controls. The panel differs by
		* task: live transcription (text only, no Interrupt), duplex conversation
		* (Interrupt / Cancel reply), voice turns (speech replies, no Interrupt), and
		* streamed text-to-speech (text input instead of the microphone).
		*/
		function LiveDock({ t, useLive, useFeatures, endLiveInput, closeLive, liveControl, dismissLive, sendLiveText }) {
			const live = useLive((snapshot) => snapshot);
			const bargeIn = useFeatures((features) => features.bargeInState);
			const [text, setText] = (0, react.useState)("");
			const now = useTicker(live.phase === "awaiting" || live.phase === "live");
			if (live.phase === "idle") return null;
			const conversation = live.kind === "conversation";
			const textInput = live.kind === "text-input";
			const inputState = live.accepted > 0 || live.observed.liveInput?.state === "verified" ? "verified" : live.observed.liveInput?.state ?? live.server?.liveInput?.state ?? live.evidence;
			const evidence = textInput ? t(`evidence.${live.evidence}`) : t(`live.input.${inputState}`);
			const duplex = live.observed.fullDuplex ?? live.server?.fullDuplex;
			const nativeDuplex = duplex !== void 0 && (duplex.state === "advertised" || duplex.state === "verified") && duplex.implementationLevel !== void 0;
			const fallback = duplex !== void 0 && duplex.state === "unsupported";
			const bargeInState = live.observed.bargeIn?.state ?? live.server?.bargeIn?.state ?? bargeIn;
			const openResponse = conversation && live.responses.some((response) => response.status === "created");
			const bufferedSeconds = live.queued * live.frameMs / 1e3;
			const maxSeconds = live.maxQueued * live.frameMs / 1e3;
			const waitedMs = live.inputEndedAt === void 0 ? 0 : now - live.inputEndedAt;
			const noReplyYet = live.phase === "awaiting" && live.responses.length === 0 && live.turns.length === 0 && waitedMs >= NO_REPLY_HINT_MS;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: audio_module_css_default.bar,
				"aria-label": t(PANEL_LABEL[live.kind]),
				"data-testid": "dsh-voice-capture-live-panel",
				"data-phase": live.phase,
				"data-evidence": live.evidence,
				"data-kind": live.kind,
				"data-task": live.task,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: cx(audio_module_css_default.row, audio_module_css_default.nowrap),
						children: [
							live.phase === "live" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: audio_module_css_default.recDot,
								"aria-hidden": "true"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: audio_module_css_default.title,
								"aria-live": "polite",
								children: live.phase === "opening" ? t("live.opening") : live.phase === "live" ? t(LIVE_TITLE[live.kind]) : live.phase === "awaiting" ? t("live.awaiting") : live.phase === "closing" ? t("live.closing") : live.phase === "closed" ? t("live.closed") : t("live.error", { detail: errorText(live, t) })
							}),
							(live.phase === "live" || live.phase === "awaiting") && !textInput && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: audio_module_css_default.timer,
								children: clockText(live.elapsedMs)
							}),
							live.phase === "live" && !textInput && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: audio_module_css_default.meter,
								role: "meter",
								"aria-label": t("level.label"),
								"aria-valuemin": 0,
								"aria-valuemax": 100,
								"aria-valuenow": Math.round(live.level * 100),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: audio_module_css_default.meterFill,
									style: { transform: `scaleX(${live.level.toFixed(3)})` }
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: cx(audio_module_css_default.caption, audio_module_css_default.truncate, (textInput ? live.evidence : inputState) !== "verified" && audio_module_css_default.warn),
								"data-testid": "dsh-voice-capture-live-evidence",
								"data-state": textInput ? live.evidence : inputState,
								children: evidence
							})
						]
					}),
					conversation && live.phase !== "opening" && live.phase !== "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(audio_module_css_default.caption, !nativeDuplex && audio_module_css_default.warn),
						role: "status",
						"data-testid": "dsh-voice-capture-live-duplex",
						"data-state": duplex?.state ?? "unreported",
						"data-level": duplex?.implementationLevel,
						children: nativeDuplex ? t("live.duplex.native", { level: duplex.implementationLevel ?? "" }) : fallback ? t("live.duplex.fallback", { level: duplex.implementationLevel ?? duplex.detail ?? "" }) : t("live.duplex.unknown")
					}),
					live.phase === "live" && !textInput && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(audio_module_css_default.caption, live.framesAcked === 0 && audio_module_css_default.warn),
						role: "status",
						"data-testid": "dsh-voice-capture-live-ready",
						"data-ready": live.framesAcked > 0,
						"data-queued": live.queued,
						children: live.framesAcked === 0 ? t("live.buffering", {
							seconds: bufferedSeconds.toFixed(1),
							max: maxSeconds.toFixed(0)
						}) : live.queued > 1 ? `${t("live.speakNow")} · ${t("live.buffered", {
							seconds: bufferedSeconds.toFixed(1),
							max: maxSeconds.toFixed(0)
						})}` : t("live.speakNow")
					}),
					live.phase !== "opening" && live.phase !== "error" && !textInput && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.row,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: audio_module_css_default.caption,
							"data-testid": "dsh-voice-capture-live-stats",
							"data-rejected": live.inputRejected,
							children: [
								t("live.stats", {
									sent: live.framesSent,
									accepted: live.accepted
								}),
								live.inputRejected > 0 && ` · ${t("live.rejectedFrames", { count: live.inputRejected })}`,
								live.acceptedWhileCapturing > 0 && ` · ${t("live.acceptedEarly", { count: live.acceptedWhileCapturing })}`
							]
						})
					}),
					textInput && live.phase !== "opening" && live.phase !== "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.caption,
						"data-testid": "dsh-voice-capture-live-text-stats",
						children: t("live.textStats", { count: live.textChunks })
					}),
					live.phase === "awaiting" && live.inputEndedAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(audio_module_css_default.caption, noReplyYet && audio_module_css_default.warn),
						role: "status",
						"data-testid": "dsh-voice-capture-live-waiting",
						"data-waited-ms": Math.round(waitedMs),
						children: noReplyYet ? t("live.noReplyYet", { seconds: Math.round(waitedMs / 1e3) }) : t("live.waitingFor", { seconds: Math.round(waitedMs / 1e3) })
					}),
					live.control !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(audio_module_css_default.caption, (live.control.outcome === "error" || live.control.outcome === "unconfirmed" || live.control.outcome === "stale") && audio_module_css_default.warn),
						role: "status",
						"data-testid": "dsh-voice-capture-live-control",
						"data-type": live.control.type,
						"data-outcome": live.control.outcome,
						"data-confirmed": String(live.control.confirmed),
						"data-target": live.control.targetResponseId,
						children: controlText(live, t)
					}),
					live.integrity !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.caption,
						"data-testid": "dsh-voice-capture-live-integrity",
						"data-forwarded": live.integrity.framesForwarded,
						"data-rejected": live.integrity.serverRejectedAppends,
						children: t("live.integrity", {
							delivered: Math.max(0, live.integrity.framesForwarded - live.integrity.serverRejectedAppends),
							forwarded: live.integrity.framesForwarded,
							rejected: live.integrity.serverRejectedAppends
						})
					}),
					live.textParams !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(audio_module_css_default.caption, live.textParams.state === "rejected" && audio_module_css_default.warn),
						role: "status",
						"data-testid": "dsh-voice-capture-live-text-params",
						"data-state": live.textParams.state,
						"data-code": live.textParams.code,
						children: live.textParams.state === "applied" ? t("live.textParamsApplied", { keys: Object.keys(live.textParams.params).join(", ") }) : live.textParams.code === "UTTERANCE_IN_PROGRESS" ? t("live.textParamsInUtterance") : t("live.textParamsRejected", { detail: `${live.textParams.code ?? ""} ${live.textParams.message ?? ""}`.trim() })
					}),
					live.words.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.caption,
						"data-testid": "dsh-voice-capture-live-words",
						"data-sentences": live.words.length,
						"data-words": live.words.reduce((n, w) => n + w.words.length, 0),
						children: live.words.map((sentence, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							"data-state": sentence.state,
							children: sentence.state === "aligned" ? sentence.words.map((w) => `${w.word} ${(w.startMs / 1e3).toFixed(2)}`).join(" · ") : t(`live.words.${sentence.state === "silence" ? "silence" : "failed"}`)
						}, index))
					}),
					live.reconnecting && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(audio_module_css_default.caption, audio_module_css_default.warn),
						role: "status",
						"data-testid": "dsh-voice-capture-live-reconnecting",
						children: t("live.reconnecting")
					}),
					live.resumes > 0 && !live.reconnecting && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.caption,
						"data-testid": "dsh-voice-capture-live-resumed",
						children: t("live.resumed", { count: live.resumes })
					}),
					live.phase === "closed" && live.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(audio_module_css_default.caption, audio_module_css_default.warn),
						role: "status",
						"data-testid": "dsh-voice-capture-live-ended",
						"data-code": live.error.code,
						children: ENDED_CODES.has(live.error.code) ? t(`live.ended.${live.error.code}`) : t("live.ended.other", { detail: `${live.error.code} ${live.error.message}`.trim() })
					}),
					live.phase === "error" && (live.error?.code === "BACKEND_REJECTED" || live.error?.code === "BACKEND_UNREACHABLE") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(audio_module_css_default.caption, audio_module_css_default.warn),
						"data-testid": "dsh-voice-capture-live-hint",
						children: t("live.openRejected")
					}),
					live.notice !== void 0 && !live.notice.startsWith("resumed") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.caption,
						children: live.notice
					}),
					live.turns.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: audio_module_css_default.transcript,
						"aria-label": live.kind === "transcription" ? t("live.transcriptTitle") : t("live.transcript"),
						"data-testid": "dsh-voice-capture-live-transcript",
						children: live.turns.map((turn) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: cx(!turn.final && live.kind === "transcription" && audio_module_css_default.partial),
							"data-final": turn.final,
							"data-kind": turn.kind,
							children: [turn.text, " "]
						}, turn.id))
					}),
					live.phase === "closed" && live.log !== "none" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(audio_module_css_default.caption, live.log !== "logged" && live.log !== "logging" && audio_module_css_default.warn),
						"data-testid": "dsh-voice-capture-live-log",
						"data-log": live.log,
						"data-detail": live.logDetail,
						children: live.log === "logging" ? t("live.logging") : live.log === "logged" ? t("live.logged") : live.logDetail === "no-reply" ? t("live.logUnavailableNoReply") : live.logDetail === "no-input" ? t("live.logUnavailableNoInput") : live.logDetail === "text-input" ? t("live.notLogged") : t("live.logFailed", { detail: live.logDetail ?? live.log })
					}),
					textInput && live.phase === "live" && live.utteranceOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: audio_module_css_default.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "ghost",
							onClick: () => {
								sendLiveText("", true, false);
							},
							"data-testid": "dsh-voice-capture-live-end-utterance",
							children: t("live.endUtterance")
						})]
					}),
					textInput && live.phase === "live" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: audio_module_css_default.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							className: cx(audio_module_css_default.textInput, audio_module_css_default.paramWide),
							rows: 2,
							value: text,
							placeholder: t("live.textPlaceholder"),
							"aria-label": t("live.textPlaceholder"),
							onChange: (event) => {
								setText(event.currentTarget.value);
							},
							"data-testid": "dsh-voice-capture-live-text"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "outline",
							disabled: text.trim() === "",
							onClick: () => {
								sendLiveText(text, false, false).then((ok) => {
									if (ok) setText("");
								});
							},
							"data-testid": "dsh-voice-capture-live-send-text",
							children: t("live.sendText")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: audio_module_css_default.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }),
							live.phase === "live" && (textInput ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "outline",
								onClick: endLiveInput,
								"data-testid": "dsh-voice-capture-live-end-input",
								children: t("live.finishText")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "outline",
								onClick: endLiveInput,
								"data-testid": "dsh-voice-capture-live-end-input",
								children: t("live.endInput")
							})),
							(live.phase === "live" || live.phase === "awaiting") && openResponse && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "ghost",
								onClick: () => {
									liveControl("cancel-response");
								},
								children: t("live.cancelResponse")
							}),
							(live.phase === "live" || live.phase === "awaiting") && openResponse && bargeInState !== "unsupported" && !fallback && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "ghost",
								onClick: () => {
									liveControl("barge-in");
								},
								title: t(`evidence.${bargeInState}`),
								children: t("live.bargeIn")
							}),
							(live.phase === "opening" || live.phase === "live" || live.phase === "awaiting") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "primary",
								onClick: closeLive,
								"data-testid": "dsh-voice-capture-live-close",
								children: t("live.close")
							}),
							(live.phase === "closed" || live.phase === "error") && live.log !== "logging" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "ghost",
								onClick: dismissLive,
								"data-testid": "dsh-voice-capture-live-dismiss",
								children: t("live.dismiss")
							})
						]
					})
				]
			});
		}
		const PANEL_LABEL = {
			"conversation": "live.panel",
			"transcription": "live.panelTranscription",
			"turn": "live.panelTurn",
			"text-input": "live.panelTextInput"
		};
		const LIVE_TITLE = {
			"conversation": "live.sending",
			"transcription": "live.transcribing",
			"turn": "live.sending",
			"text-input": "live.textLive"
		};
		/** Interrupt / Cancel reply outcome: "interrupted" only when the host confirmed the cancelled response (§K.10). */
		function controlText(live, t) {
			const control = live.control;
			const action = t(control.type === "barge-in" ? "live.bargeIn" : "live.cancelResponse");
			switch (control.outcome) {
				case "pending": return t("live.control.pending", { action });
				case "no-active-response": return t("live.control.nothing", { action });
				case "response-not-active": return t("live.control.notActive", { action });
				case "response-already-completed": return t("live.control.alreadyFinished", { action });
				case "stale":
				case "unconfirmed": return t("live.control.unconfirmed", { action });
				case "cancelled": return control.confirmed ? t("live.control.done", { action }) : t("live.control.cancelledPending", { action });
				case "no-outcome": return t("live.control.noOutcome", { action });
				default: return t("live.control.failed", {
					action,
					detail: control.reason ?? ""
				});
			}
		}
		function errorText(live, t) {
			const code = live.error?.code;
			if (code === "MIC_BUSY") return t("live.micBusy");
			if (code === "SERVER_BUSY") return t("live.serverBusy", { detail: live.error?.message ?? "" });
			if (code === "MODEL_NOT_READY") return t("live.notReady");
			return `${code ?? ""} ${live.error?.message ?? ""}`.trim();
		}
		/** Wall-clock milliseconds on the `performance.now()` axis, refreshed every second while `active`. */
		function useTicker(active) {
			const [now, setNow] = (0, react.useState)(() => performance.now());
			(0, react.useEffect)(() => {
				if (!active) return;
				setNow(performance.now());
				const timer = setInterval(() => {
					setNow(performance.now());
				}, 1e3);
				return () => {
					clearInterval(timer);
				};
			}, [active]);
			return now;
		}
		//#endregion
		//#region src/client/audio/ReplyBar.tsx
		/** Adapter tasks whose audio is generated content, not the other side of a conversation (TASK_CONTRACT 0.2 §A). */
		const GENERATED_AUDIO_TASKS = new Set([
			"tts.speech",
			"audio.generate",
			"tts.stream-input"
		]);
		/** How long a finished reply status stays visible. */
		const ENDED_VISIBLE_MS = 6e3;
		/**
		* Progressive reply playback status above the composer (CONTRACT §3). The
		* streaming label appears only when audio was scheduled before the reply
		* ended; a host `final-only` delivery is labelled as a complete audio reply.
		*/
		function ReplyBar({ t, usePlayback, useLive, stopPlayback, setAutoplay, attachFeed }) {
			const playback = usePlayback((snapshot) => snapshot);
			const liveKind = useLive((snapshot) => snapshot.kind);
			(0, react.useEffect)(() => attachFeed(), [attachFeed]);
			const [endedVisible, setEndedVisible] = (0, react.useState)(true);
			(0, react.useEffect)(() => {
				if (playback.phase !== "ended" && playback.phase !== "stopped") {
					setEndedVisible(true);
					return;
				}
				const timer = setTimeout(() => {
					setEndedVisible(false);
				}, ENDED_VISIBLE_MS);
				return () => {
					clearTimeout(timer);
				};
			}, [playback.phase, playback.streamId]);
			if (playback.phase === "idle" || (playback.phase === "ended" || playback.phase === "stopped") && !endedVisible) return null;
			const streamingObserved = playback.playedBeforeEnd || playback.hostDelivery === "pending" && playback.chunks >= 2 && playback.playbackScheduledAt !== void 0;
			const generated = playback.task !== void 0 && GENERATED_AUDIO_TASKS.has(playback.task) || playback.origin === "live" && liveKind === "text-input";
			const title = playback.phase === "receiving" ? t(generated ? "reply.generated.receiving" : "reply.receiving") : playback.phase === "playing" ? streamingObserved && playback.hostDelivery !== "final-only" ? t(generated ? "reply.generated.playingStreaming" : "reply.speakingStreaming") : t(generated ? "reply.generated.playing" : "reply.speakingFinal") : playback.phase === "stopped" ? t("reply.stopped") : t(generated ? "reply.generated.ended" : "reply.ended");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
				className: audio_module_css_default.bar,
				"aria-label": t(generated ? "reply.generated.label" : "reply.label"),
				"data-testid": "dsh-voice-capture-reply-bar",
				"data-kind": generated ? "generated" : "spoken",
				"data-task": playback.task,
				"data-phase": playback.phase,
				"data-delivery": playback.hostDelivery,
				"data-played-before-end": String(playback.playedBeforeEnd),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: audio_module_css_default.row,
					children: [
						playback.phase === "playing" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.speaking,
							"aria-hidden": "true"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.title,
							"aria-live": "polite",
							children: title
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.caption,
							children: playback.hostDelivery === "final-only" ? t(generated ? "reply.generated.finalOnly" : "reply.finalOnly") : playback.playedBeforeEnd ? t("reply.progressive", { chunks: playback.chunks }) : ""
						}),
						playback.gaps > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: audio_module_css_default.caption,
							children: t("reply.gaps", { gaps: playback.gaps })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: audio_module_css_default.spacer }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: audio_module_css_default.toggle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: playback.autoplay,
								onChange: (event) => {
									setAutoplay(event.currentTarget.checked);
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(generated ? "reply.generated.autoplay" : "reply.autoplay") })]
						}),
						(playback.phase === "playing" || playback.phase === "receiving") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "outline",
							onClick: stopPlayback,
							"data-testid": "dsh-voice-capture-reply-stop",
							children: t("reply.stop")
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Services this plugin waits for. */
		const inject = [
			"slots",
			"locale",
			"fileUpload",
			"sessions",
			"uiConversation"
		];
		/** Longest reference voice recording. */
		const REFERENCE_MAX_MS = 3e4;
		/** Interval of playback acknowledgements sent from the real player position during Live mode. */
		const PLAYBACK_ACK_MS = 500;
		/**
		* Register dictionaries, controllers and every slot entry.
		* @param ctx - client plugin context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "voice-capture: dictionaries");
			ctx.effect(() => ctx.uiConversation.events.register(voiceAudioDefinition), "voice-capture: reply recordings definition");
			const fetchImpl = (input, init) => fetch(input, init);
			const backend = browserCaptureBackend();
			const uploadPort = { upload: (sessionId, data, name, signal, onProgress) => ctx.fileUpload.upload(sessionId, data, name, signal, onProgress) };
			const sessionPort = { binding: (id) => ctx.sessions.binding(id) };
			let live;
			let referenceRecorder;
			const controller = new VoiceCaptureController(backend, uploadPort, sessionPort, DEFAULT_SPEC, void 0, void 0, () => live?.active === true || referenceRecorder?.capturing === true);
			referenceRecorder = new VoiceCaptureController(backend, uploadPort, sessionPort, {
				...DEFAULT_SPEC,
				maxDurationMs: REFERENCE_MAX_MS
			}, void 0, void 0, () => live?.active === true || controller.capturing);
			const taskInputs = new TaskInputsController(uploadPort, sessionPort, (input, init) => fetch(input, init));
			const logExchange = async (sessionId, input) => {
				const binding = ctx.sessions.binding(sessionId);
				if (binding === void 0 || typeof input.receiptId !== "string") return {
					ok: false,
					detail: "session-unavailable"
				};
				const attachments = typeof input.attachmentId === "string" ? [{
					type: "file",
					value: {
						attachmentId: input.attachmentId,
						name: liveInputName(input),
						bytes: input.bytes
					}
				}] : [];
				const submission = binding.session.beginSubmission({
					mode: "queue",
					text: "",
					attachments
				});
				const result = await binding.session.prompt([{
					type: "file",
					receiptId: input.receiptId
				}], "queue", void 0, submission.requestId);
				return result.ok ? { ok: true } : {
					ok: false,
					detail: `${result.error.code}: ${result.error.message}`
				};
			};
			live = new LiveController(backend, fetchImpl, () => controller.capturing || referenceRecorder?.capturing === true, logExchange);
			const capabilities = new CapabilityDirectory(fetchImpl);
			const board = new ActivationBoard(() => ctx.get("audioModelLibrary"));
			ctx.effect(() => ctx.on("internal/service", (name) => {
				if (name === "audioModelLibrary") board.libraryChanged();
			}), "voice-capture: follow the model library service");
			let reloadTimer;
			/** Refresh capabilities after an activation change; events older than the new document are dropped. */
			const reloadAfterModelState = () => {
				clearTimeout(reloadTimer);
				reloadTimer = setTimeout(() => {
					const since = Date.now();
					capabilities.load(true).then(() => {
						board.documentLoaded(since);
					});
				}, 500);
			};
			const players = /* @__PURE__ */ new Map();
			const videoJobs = /* @__PURE__ */ new Map();
			const videoProgressFor = (sessionId) => {
				let entry = videoJobs.get(sessionId);
				if (entry === void 0) {
					entry = {
						value: void 0,
						listeners: /* @__PURE__ */ new Set()
					};
					videoJobs.set(sessionId, entry);
				}
				const current = entry;
				return {
					getSnapshot: () => current.value,
					subscribe: (listener) => {
						current.listeners.add(listener);
						return () => {
							current.listeners.delete(listener);
						};
					},
					set: (value) => {
						current.value = value;
						for (const listener of [...current.listeners]) listener();
					}
				};
			};
			const features = /* @__PURE__ */ new Map();
			const feeds = /* @__PURE__ */ new Map();
			const playerFor = (sessionId) => {
				let player = players.get(sessionId);
				if (player === void 0) {
					player = new ProgressivePlayer(webAudioOutput);
					players.set(sessionId, player);
				}
				return player;
			};
			const featuresFor = (sessionId) => {
				let source = features.get(sessionId);
				if (source === void 0) {
					const selection = ctx.sessions.binding(sessionId)?.session.projections.faceOf("modelSelection") ?? {
						getSnapshot: () => void 0,
						subscribe: () => () => {}
					};
					source = capabilities.featuresFor(selection);
					features.set(sessionId, source);
				}
				return source;
			};
			const gates = /* @__PURE__ */ new Map();
			/** Activation gate of the selected model: library service and adapter activation combined. */
			const gateFor = (sessionId) => {
				let source = gates.get(sessionId);
				if (source !== void 0) return source;
				const features = featuresFor(sessionId);
				let cached;
				source = {
					getSnapshot: () => {
						const current = features.getSnapshot();
						const next = current.selection === void 0 ? { state: "unknown" } : current.liveOnly ? {
							state: "live-only",
							source: "adapter"
						} : board.gate(current.selection.provider, current.selection.model, current.model);
						const key = gateKey(next);
						if (cached?.key !== key) cached = {
							key,
							value: next
						};
						return cached.value;
					},
					subscribe: (listener) => {
						const stopFeatures = features.subscribe(listener);
						const stopBoard = board.subscribe(listener);
						return () => {
							stopFeatures();
							stopBoard();
						};
					}
				};
				gates.set(sessionId, source);
				return source;
			};
			const liveGates = /* @__PURE__ */ new Map();
			/** Activation gates of every live candidate, keyed by model id. */
			const liveGatesFor = (sessionId) => {
				let source = liveGates.get(sessionId);
				if (source !== void 0) return source;
				const features = featuresFor(sessionId);
				let cached;
				source = {
					getSnapshot: () => {
						const next = Object.fromEntries(features.getSnapshot().liveCandidates.map((c) => [c.model.model, board.gate(c.model.provider, c.model.model, c.entry)]));
						const key = JSON.stringify(next);
						if (cached?.key !== key) cached = {
							key,
							value: next
						};
						return cached.value;
					},
					subscribe: (listener) => {
						const stopFeatures = features.subscribe(listener);
						const stopBoard = board.subscribe(listener);
						return () => {
							stopFeatures();
							stopBoard();
						};
					}
				};
				liveGates.set(sessionId, source);
				return source;
			};
			/**
			* Work on the same adapter provider that would make a live open time out (I2-A case 6-3): an unfinished
			* reply or another live session. Hosts without `GET activity` (before 0.4.0) report nothing.
			*/
			const serverBusy = async (provider, sessionId) => {
				try {
					const activity = await requestJson(fetchImpl, `${ROUTE_PREFIX}/activity?provider=${encodeURIComponent(provider)}`);
					const work = activity.inflight?.find((item) => item.kind !== "auxiliary");
					if (work !== void 0) return `${work.kind ?? "request"} · ${work.model ?? ""}${work.sessionId === sessionId ? "" : " (another conversation)"}`.trim();
					const other = activity.live?.find((item) => item.state !== "closed");
					if (other !== void 0) return `live · ${other.model ?? ""}${other.sessionId === sessionId ? "" : " (another conversation)"}`.trim();
					return;
				} catch {
					return;
				}
			};
			/** Reason a request to the selected model must not be sent now (checked again right before admission). */
			const blockedReason = (sessionId) => {
				const gate = gateFor(sessionId).getSnapshot();
				return gateBlocks(gate) ? gate.state : void 0;
			};
			const extrasFor = (sessionId) => {
				const blocked = () => blockedReason(sessionId);
				const model = featuresFor(sessionId).getSnapshot().model;
				return model === void 0 ? { blocked } : {
					...taskInputs.extras(sessionId, model.id, taskView(model)),
					blocked
				};
			};
			/** Session-params target: the selected model, or a live candidate of its route. */
			const paramsTarget = (sessionId, modelId) => {
				const current = featuresFor(sessionId).getSnapshot();
				if (current.model === void 0 || current.selection === void 0) return void 0;
				if (modelId === void 0 || modelId === current.model.id) return {
					provider: current.selection.provider,
					model: current.model.id,
					view: taskView(current.model)
				};
				const candidate = current.liveCandidates.find((c) => c.model.model === modelId);
				return candidate === void 0 ? void 0 : {
					provider: candidate.model.provider,
					model: candidate.model.model,
					view: taskView(candidate.entry)
				};
			};
			const releaseFeed = (sessionId) => {
				const feed = feeds.get(sessionId);
				if (feed === void 0) return;
				feed.refs--;
				if (feed.refs > 0 || live?.owner === sessionId) return;
				feed.dispose();
				feeds.delete(sessionId);
			};
			const attachFeed = (sessionId) => {
				const existing = feeds.get(sessionId);
				if (existing !== void 0) existing.refs++;
				else {
					const player = playerFor(sessionId);
					const dispose = subscribeAudioEvents(fetchImpl, sessionId, {
						onEvent: (event) => {
							if (event.type.startsWith("audio.")) player.handle(event);
							if (event.type.startsWith("live.") || event.type === "text.delta") live?.handleEvent(event);
							if (event.type === "model.state" && board.handleModelState(event)) reloadAfterModelState();
							if (event.type === "video.progress" && typeof event.jobId === "string") videoProgressFor(sessionId).set({
								model: typeof event.model === "string" ? event.model : void 0,
								jobId: event.jobId,
								status: String(event.status ?? ""),
								progress: typeof event.progress === "number" ? event.progress : void 0
							});
						},
						onState: () => {}
					});
					feeds.set(sessionId, {
						refs: 1,
						dispose
					});
				}
				let released = false;
				return () => {
					if (released) return;
					released = true;
					releaseFeed(sessionId);
				};
			};
			ctx.effect(() => {
				let lastAck = -1;
				const timer = setInterval(() => {
					const owner = live?.owner;
					if (owner === void 0) return;
					const position = players.get(owner)?.playedPosition();
					if (position === void 0 || position.origin !== "live" || position.playedMs === lastAck) return;
					lastAck = position.playedMs;
					live?.playbackAck(position.streamId, position.playedMs);
				}, PLAYBACK_ACK_MS);
				const onPageHide = () => {
					referenceRecorder?.dispose();
					taskInputs.dispose();
					controller.dispose();
					live?.dispose();
				};
				window.addEventListener("pagehide", onPageHide);
				return () => {
					clearInterval(timer);
					clearTimeout(reloadTimer);
					window.removeEventListener("pagehide", onPageHide);
					referenceRecorder?.dispose();
					taskInputs.dispose();
					controller.dispose();
					live?.dispose();
					for (const feed of feeds.values()) feed.dispose();
					feeds.clear();
					for (const player of players.values()) player.dispose();
					players.clear();
				};
			}, "voice-capture: release microphone, live session, feeds and playback on unload");
			const voiceFace = (sessionId) => ({
				start: () => {
					controller.start(sessionId);
				},
				stop: () => {
					controller.stop(sessionId);
				},
				cancel: () => {
					controller.cancel(sessionId);
				},
				send: (text) => controller.send(sessionId, text, extrasFor(sessionId)),
				selectDevice: (deviceId) => {
					controller.selectDevice(deviceId);
				},
				dismissError: () => {
					controller.dismissError(sessionId);
				},
				detach: () => {
					controller.detach(sessionId);
				},
				refreshDevices: () => {
					controller.refreshDevices();
				},
				openLibrary: () => board.openLibrary(sessionId),
				hooks: {
					voice: controller.source(sessionId),
					gate: gateFor(sessionId)
				}
			});
			const audioFace = (sessionId) => ({
				attachFeed: () => attachFeed(sessionId),
				stopPlayback: () => {
					playerFor(sessionId).stop();
				},
				setAutoplay: (enabled) => {
					playerFor(sessionId).setAutoplay(enabled);
				},
				startLive: (modelId) => {
					const current = featuresFor(sessionId).getSnapshot();
					const candidate = modelId === void 0 ? current.liveCandidates.find((c) => c.available) : current.liveCandidates.find((c) => c.model.model === modelId);
					if (candidate === void 0 || !candidate.available) return;
					if (ctx.sessions.binding(sessionId)?.session.getSnapshot().running === true) return;
					if (gateBlocks(board.gate(candidate.model.provider, candidate.model.model, candidate.entry))) return;
					const release = attachFeed(sessionId);
					(async () => {
						const view = taskView(candidate.entry);
						if (!await taskInputs.applyParams(sessionId, {
							provider: candidate.model.provider,
							model: candidate.model.model,
							view
						})) return;
						await live?.start(sessionId, candidate.model, candidate.evidence, false, candidate.kind, () => serverBusy(candidate.model.provider, sessionId));
					})().finally(release);
				},
				endLiveInput: () => {
					live?.endInput();
				},
				sendLiveText: (text, done, endSession) => {
					const liveModel = live?.source.getSnapshot().model;
					const candidate = liveModel === void 0 ? void 0 : featuresFor(sessionId).getSnapshot().liveCandidates.find((c) => c.model.model === liveModel.model);
					const params = candidate === void 0 ? void 0 : resolveOptions(taskView(candidate.entry).params, taskInputs.source(sessionId).getSnapshot().values[candidate.model.model] ?? {}, false);
					return live?.sendText(text, done, params, endSession ?? done) ?? Promise.resolve(false);
				},
				closeLive: () => {
					live?.close().finally(() => {
						capabilities.load(true);
					});
				},
				liveControl: (type) => {
					live?.control(type);
				},
				dismissLive: () => {
					live?.dismiss();
				},
				openLibrary: () => board.openLibrary(sessionId),
				hooks: {
					playback: playerFor(sessionId).source,
					features: featuresFor(sessionId),
					live: live.source,
					gate: gateFor(sessionId),
					liveGates: liveGatesFor(sessionId)
				}
			});
			const taskFace = (sessionId) => ({
				setValue: (key, value, model) => {
					const target = paramsTarget(sessionId, model);
					if (target !== void 0) taskInputs.setValue(sessionId, target.model, key, value, target);
				},
				pickReference: (file, slot) => {
					taskInputs.setReference(sessionId, file, "file", file.name, slot);
				},
				clearReference: (slot) => {
					taskInputs.clearReference(sessionId, slot);
				},
				setConsent: (consent, slot) => {
					taskInputs.setConsent(sessionId, consent, slot);
				},
				setReferenceText: (text) => {
					taskInputs.setReferenceText(sessionId, text);
				},
				startReference: () => {
					referenceRecorder.start(sessionId);
				},
				stopReference: () => {
					referenceRecorder.stop(sessionId);
				},
				keepReference: () => {
					const clip = referenceRecorder.takeClip(sessionId);
					if (clip !== void 0) taskInputs.setReference(sessionId, new Blob([clip.data], { type: "audio/wav" }), "recorded", clip.name);
				},
				discardRecordedReference: () => {
					referenceRecorder.cancel(sessionId);
				},
				generate: (text) => {
					const model = featuresFor(sessionId).getSnapshot().model;
					return model === void 0 ? Promise.resolve(false) : taskInputs.generate(sessionId, model.id, taskView(model), text, () => blockedReason(sessionId));
				},
				loadValues: (url) => loadValues(url),
				openLibrary: () => board.openLibrary(sessionId),
				cancelGenerate: () => {
					taskInputs.cancel(sessionId);
				},
				dismissTaskError: () => {
					taskInputs.dismissError(sessionId);
				},
				hooks: {
					features: featuresFor(sessionId),
					taskInputs: taskInputs.source(sessionId),
					referenceVoice: referenceRecorder.source(sessionId),
					gate: gateFor(sessionId),
					videoProgress: videoProgressFor(sessionId)
				}
			});
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "dsh-voice-capture-mic",
				order: 10,
				locale: NS,
				inject: voiceFace
			}, MicButton));
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "dsh-voice-capture-live",
				order: 11,
				locale: NS,
				inject: audioFace
			}, LiveButton));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "dsh-voice-capture-task",
				order: 84,
				locale: NS,
				inject: taskFace
			}, TaskStrip));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "dsh-voice-capture-live-panel",
				order: 86,
				locale: NS,
				inject: audioFace
			}, LiveDock));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "dsh-voice-capture-reply-bar",
				order: 88,
				locale: NS,
				inject: audioFace
			}, ReplyBar));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "dsh-voice-capture-panel",
				order: 90,
				locale: NS,
				inject: voiceFace
			}, VoiceDock));
			const valuesCache = /* @__PURE__ */ new Map();
			/** Server value list for a `valuesFrom` parameter (voices); failures are not cached. */
			const loadValues = (url) => {
				let pending = valuesCache.get(url);
				if (pending === void 0) {
					pending = requestJson(fetchImpl, url).then(voiceNames);
					pending.catch(() => {
						valuesCache.delete(url);
					});
					valuesCache.set(url, pending);
				}
				return pending;
			};
			const resultCache = /* @__PURE__ */ new Map();
			const loadResult = (resultId, seq) => {
				const key = `${seq}:${resultId}`;
				let pending = resultCache.get(key);
				if (pending === void 0) {
					pending = fetchImpl(routeUrl(`${ROUTE_PREFIX}/result?id=${encodeURIComponent(resultId)}`), { credentials: "include" }).then(async (response) => response.ok ? parseResultDocument(await response.json(), seq) : void 0).catch(() => void 0);
					pending.then((value) => {
						if (value === void 0) resultCache.delete(key);
					}, () => {
						resultCache.delete(key);
					});
					resultCache.set(key, pending);
				}
				return pending;
			};
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				select: selectReplyRecordings,
				priority: 1,
				locale: NS,
				inject: () => ({ loadResult })
			}, AudioReplies));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map