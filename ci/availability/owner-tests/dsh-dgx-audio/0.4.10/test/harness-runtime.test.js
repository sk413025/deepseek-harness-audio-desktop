// The plugin loaded into a real Cordis Context with the real dsh-llm LlmRuntime (0.1.5-rc.1):
// proves deltas pass through `ctx.llm.stream` unbuffered and failures normalize to the
// runtime's terminal finish chunks. Scripted local SSE server; not a live model server.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'

import * as plugin from '../src/index.js'
import { omni, scriptedServer, sleep, tempDir, writeSse } from './helpers/fixtures.js'

async function loadPlugin(baseURL, extra = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const outputDir = await tempDir('dgx-runtime-')
  const fiber = ctx.plugin(plugin, {
    outputDir,
    httpRoutes: false,
    routes: [{ provider: 'lab-omni', displayName: 'Lab Omni', baseURL, models: [{ id: 'omni', sendModalities: true, outputAudio: false, ...extra }] }],
  })
  await fiber
  return { ctx, fiber, outputDir }
}

test('real LlmRuntime: text deltas are delivered while the server is still streaming', async (tc) => {
  let doneWrittenAt
  const server = await scriptedServer(async (req, res) => {
    await writeSse(res, [omni.role(), omni.text('alpha '), omni.text('beta '), omni.text('gamma'), omni.usage(), '[DONE]'], {
      delayMs: 200,
      onEach: (i) => { if (i === 5) doneWrittenAt = performance.now() },
    })
  })
  tc.after(() => server.close())
  const { ctx } = await loadPlugin(server.url)
  assert.deepEqual(ctx.llm.listProviders().map(p => p.id).filter(id => id === 'lab-omni'), ['lab-omni'])
  const seen = []
  for await (const chunk of ctx.llm.stream({ provider: 'lab-omni', model: 'omni', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
    seen.push({ chunk, at: performance.now() })
  }
  const deltas = seen.filter(s => s.chunk.type === 'text-delta')
  assert.equal(deltas[0].chunk.text, 'alpha ')
  assert.ok(deltas[0].at < doneWrittenAt - 600, 'first delta left the runtime ≥ 3 scripted gaps before [DONE]')
  const finish = seen.at(-1).chunk
  assert.deepEqual(finish, { type: 'finish', reason: { kind: 'stop' } })
  assert.ok(seen.some(s => s.chunk.type === 'usage'))
  await ctx.registry.delete?.(plugin)
})

test('real LlmRuntime: abort and backend failures become terminal finish chunks with our codes', async (tc) => {
  const server = await scriptedServer(async (req, res, call) => {
    if (call.json?.messages?.[0]?.content?.[0]?.text === 'fail') {
      await writeSse(res, [omni.text('x'), { error: { message: 'engine died', code: 503 } }])
      return
    }
    await writeSse(res, [omni.role(), ...Array.from({ length: 40 }, (_, i) => omni.text(`${i} `)), '[DONE]'], { delayMs: 50 })
  })
  tc.after(() => server.close())
  const { ctx } = await loadPlugin(server.url)
  const controller = new AbortController()
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider: 'lab-omni', model: 'omni', signal: controller.signal, messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] })) {
    chunks.push(chunk)
    if (chunk.type === 'text-delta' && chunks.length === 3) controller.abort()
  }
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'aborted')
  await sleep(50)
  assert.equal(server.calls[0].clientClosed, true)

  const failed = []
  for await (const chunk of ctx.llm.stream({ provider: 'lab-omni', model: 'omni', messages: [{ role: 'user', content: [{ type: 'text', text: 'fail' }] }] })) failed.push(chunk)
  assert.equal(failed.at(-1).reason.kind, 'error')
  assert.equal(failed.at(-1).reason.failure.code, 'SERVER')
  assert.equal(failed.at(-1).reason.failure.status, 503)
})

test('real Cordis: another plugin can inject the dshAudio service and drive activation', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const outputDir = await tempDir('dgx-inject-')
  await ctx.plugin(plugin, { outputDir, httpRoutes: false, routes: [] })
  let seen
  await ctx.plugin({
    name: 'fake-model-library',
    inject: ['dshAudio'],
    apply(child) {
      const svc = child.dshAudio
      const source = svc.registerRouteSource('fake-library', [{ provider: 'lib-a', displayName: 'Lib A', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'm1' }] }])
      seen = { contract: svc.contractVersion, activation: null, source }
    },
  })
  await seen.source.ready
  assert.equal(seen.contract, '0.2')
  assert.deepEqual(ctx.llm.listProviders().map(p => p.id).filter(id => id === 'lib-a'), ['lib-a'])
  const svc = ctx.get('dshAudio')
  const failed = []
  for await (const chunk of ctx.llm.stream({ provider: 'lib-a', model: 'm1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) failed.push(chunk)
  assert.equal(failed.at(-1).reason.failure.code, 'MODEL_NOT_READY')
  assert.equal(svc.setActivation('lib-a', 'm1', { state: 'activating', progress: 0.4 }).state, 'activating')
  assert.equal(svc.describe().routes[0].models[0].activation.progress, 0.4)
})
