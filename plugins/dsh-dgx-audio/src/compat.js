import { PLUGIN_VERSION } from './constants.js'

// Dependency-free stand-ins for the few @deepseek-ai/dsh-llm exports the adapter needs.
//
// The plugin is loaded both as a Web profile bundle (npm install tree) and as a
// path row in the Desktop profile's cordis.patch.yml, where the plugin file sits
// outside the Desktop-owned node_modules and cannot import Harness packages.
// dsh-llm 0.1.5-rc.1 neither checks `instanceof LlmAdapter` on registration nor
// relies on LlmError class identity: normalizeLlmFailure() trusts an error's own
// `code` + `failure` properties ("cross-package copies preserve own data").

/** Mirrors dsh-llm's LlmError shape: own `code` and a frozen serializable `failure`. */
export class LlmError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{ status?: number, cause?: unknown }} [options]
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LlmError'
    Object.defineProperty(this, 'code', { value: code, enumerable: true })
    Object.defineProperty(this, 'failure', {
      value: Object.freeze({ message, code, ...(options.status === undefined ? {} : { status: options.status }) }),
      enumerable: true,
    })
  }
}

/** Default method bodies of dsh-llm's abstract LlmAdapter (0.1.5-rc.1). */
export class LlmAdapterBase {
  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  providerRetryPolicy(_provider) {
    return undefined
  }

  imageRequestPricing(_provider, _model) {
    return undefined
  }

  listModels(_provider) {
    return Promise.resolve([])
  }

  resolveModel(provider, model, _signal) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) }
  }
}

/** Request attribution header (dsh-llm sends `deepseek-harness/<version> (+repo)`). */
export function attributionHeaders() {
  return { 'user-agent': `deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness) dsh-dgx-audio/${PLUGIN_VERSION}` }
}
