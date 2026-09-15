// Protocol constants shared by the adapter, routes and live driver.

export const PLUGIN_NAME = 'dsh-dgx-audio'
export const PLUGIN_VERSION = '0.4.9'
export const CONTRACT_VERSION = '0.1'

/** OpenAI-compatible SSE terminal payload. */
export const DONE = '[DONE]'

/** Host Fetch route prefix (below /api), versioned with the UI contract. */
export const ROUTE_PREFIX = '/api/dsh-dgx-audio/v1'
