export const PLUGIN_NAME = 'dsh-audio-model-library'
export const PLUGIN_VERSION = '0.1.4'
export const CONTRACT_VERSION = '0.1'
export const CONTROLLER_PROTOCOL = 'dsh.audio-controller/0.1'
export const ROUTE_PREFIX = '/api/dsh-audio-model-library/v1'
export const SETTINGS_NS = 'dsh-audio-model-library'
export const ADAPTER_NS = 'dsh-dgx-audio'
/** Modes dsh-dgx-audio 0.3.x serves when its capability document has no `adapterModes` (CONTRACT §4). */
export const DEFAULT_ADAPTER_MODES = Object.freeze(['chat', 'transcribe', 'realtime'])
export const TERMINAL_PHASES = Object.freeze(['ready', 'stopped', 'failed', 'cancelled', 'refused'])
