// Portable user-settings layer: real schemastery schema, credential references, live reconfiguration.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import z from '@deepseek-ai/schemastery'

import { resolveConfig, routeApiKey } from '../src/config.js'
import { apply } from '../src/index.js'
import { SETTINGS_NS, definedEntries, loadSchemastery, settingsSchema } from '../src/settings.js'
import { tempDir } from './helpers/fixtures.js'

const SITE = {
  routes: [{
    provider: 'lab-duplex', displayName: 'Lab duplex', baseURL: 'http://192.0.2.10:18120/v1',
    models: [
      { id: 'minicpmo45-clip', upstreamModel: 'openbmb/MiniCPM-o-4_5', outputAudio: true, sendModalities: true, extraBody: { chat_template_kwargs: { enable_thinking: false, use_tts_template: true } } },
      { id: 'minicpmo45-duplex', upstreamModel: 'openbmb/MiniCPM-o-4_5', mode: 'realtime', realtime: { query: { minicpmo45_native_duplex: '1' }, refAudioFile: '/opt/voices/ref.wav' } },
    ],
  }],
}

test('settings schema (real schemastery) accepts a site config and resolves it without undefined overrides', async () => {
  assert.equal(typeof (await loadSchemastery()).object, 'function')
  assert.equal(await loadSchemastery(async () => { throw new Error('not resolvable') }), undefined)
  const schema = settingsSchema(z)
  const value = schema(SITE)
  const config = resolveConfig({ outputDir: await tempDir(), ...definedEntries(value) })
  const [clip, duplex] = config.routes[0].models
  assert.equal(clip.mode, 'chat')
  assert.equal(clip.realtime, undefined)
  assert.deepEqual(clip.extraBody, { chat_template_kwargs: { enable_thinking: false, use_tts_template: true } })
  assert.equal(duplex.realtime.path, '/realtime', 'schema-produced undefined must not erase defaults')
  assert.equal(duplex.realtime.inputSampleRate, 16000)
  assert.deepEqual(duplex.realtime.query, { duplex: '1', autostart: '0', minicpmo45_native_duplex: '1' })
  assert.equal(JSON.stringify(schema.toJSON()).includes('credential-ref'), true, 'apiKeyEnv is a credential reference, not a stored secret')
  assert.throws(() => schema({ routes: [{ provider: 'x', displayName: 'X', models: [] }] }))
})

test('credential reference: keyless by default, env var when configured, never required', () => {
  const route = { provider: 'p', displayName: 'P', baseURL: 'http://h/v1', models: [{ id: 'm' }] }
  assert.equal(routeApiKey(resolveConfig({ routes: [route] }).routes[0], {}), undefined)
  const withRef = resolveConfig({ routes: [{ ...route, apiKeyEnv: 'LAB_AUDIO_KEY' }] }).routes[0]
  assert.equal(routeApiKey(withRef, {}), undefined)
  assert.equal(routeApiKey(withRef, { LAB_AUDIO_KEY: ' secret ' }), 'secret')
  assert.throws(() => resolveConfig({ routes: [{ ...route, apiKeyEnv: 'not a var' }] }), /environment variable/)
  assert.equal(resolveConfig({ routes: [{ ...route, apiKeyEnv: '' }] }).routes[0].apiKeyEnv, undefined)
})

test('plugin installs a settings section and re-registers adapter routes when the user edits settings', async () => {
  const registrations = []
  let section
  let settingsCallback
  const logs = []
  const ctx = {
    logger: { info: m => logs.push(m), error: m => logs.push(`ERROR ${m}`) },
    llm: { registerAdapter: (providers) => { const handle = () => { handle.disposed = true }; handle.replace = next => registrations.push(['replace', next]); registrations.push(['register', providers]); return handle } },
    get: () => undefined,
    effect: fn => fn(),
    inject: (deps, cb) => { if (deps[0] === 'settings') settingsCallback = cb },
  }
  apply(ctx, { outputDir: await tempDir(), httpRoutes: false })
  assert.deepEqual(registrations, [])
  let stored = {}
  await settingsCallback({ settings: { installSection: (owner, ns, schema, entry, hooks) => { section = { ns, schema, hooks }; hooks.setSource(() => schema(stored)); hooks.onChange() } } })
  assert.equal(section.ns, SETTINGS_NS)
  assert.deepEqual(registrations, [], 'empty settings register nothing')
  stored = SITE
  section.hooks.validate(section.schema(stored))
  section.hooks.onChange()
  assert.deepEqual(registrations, [['register', ['lab-duplex']]])
  stored = { routes: [] }
  section.hooks.onChange()
  assert.deepEqual(registrations.at(-1), ['replace', []])
  assert.throws(() => section.hooks.validate({ routes: [{ provider: 'x', displayName: 'X', baseURL: 'ftp://nope', models: [{ id: 'm' }] }] }), /http\(s\)/)
  assert.ok(!logs.some(l => l.startsWith('ERROR')))
})
