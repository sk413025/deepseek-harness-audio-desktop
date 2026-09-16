#!/usr/bin/env node
// Create one Session (audio-no-tools preset, mock model) in the isolated web server and send a
// text-only setup prompt so the Session is listed in the sidebar.
// Usage: node seed-session.mjs <cdpPort> <baseUrl> <cookieJar> <workspaceDir>
import { readFileSync } from 'node:fs'
import { attach, sleep } from './cdp-lib.mjs'

const [portArg, baseUrl, cookieJar, workspace] = process.argv.slice(2)
const page = await attach(Number(portArg), url => url.startsWith('http') || url.startsWith('dsh-app:') || url === 'about:blank')
await page.send('Network.enable')
const cookie = cookieJar === '-' ? undefined : readFileSync(cookieJar, 'utf8').split('\n').find(line => line.includes('dsh-auth'))?.split('\t')
if (cookie !== undefined) await page.send('Network.setCookie', { name: cookie[5], value: cookie[6].trim(), domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' })
await page.evaluate(`location.href = ${JSON.stringify(baseUrl)}; 1`)
await page.waitFor(`!!window.__DSH_BOOT__ && document.body.innerText.includes('Workspaces')`, { timeoutMs: 30000, label: 'app boot' })
await page.evaluate(readFileSync(new URL('./rpc-in-page.js', import.meta.url), 'utf8') + '; 1')
const created = await page.evaluate(`window.__dshRpc('session/create', { cwd: ${JSON.stringify(workspace)}, agentPreset: 'audio-no-tools' })`)
await page.evaluate(`window.__dshRpc('session/selectModel', { sessionId: ${JSON.stringify(created.sessionId)}, provider: ${JSON.stringify(process.env.SEED_PROVIDER ?? 'mock-audio')}, model: ${JSON.stringify(process.env.SEED_MODEL ?? 'mock-audio-chat')} })`)
await page.evaluate(`window.__dshRpc('session/prompt', { requestId: crypto.randomUUID(), sessionId: ${JSON.stringify(created.sessionId)}, mode: 'queue', clientTimeZone: 'Asia/Taipei', content: [{ type: 'text', text: 'E2E setup: text-only hello (no audio)' }] })`)
await sleep(4000)
const bootEntry = await page.evaluate(`(window.__DSH_BOOT__.entries.find(e => e.id === 'dsh-voice-capture') ?? null)`)
console.log(JSON.stringify({ sessionId: created.sessionId, bootEntries: await page.evaluate('window.__DSH_BOOT__.entries.length'), voiceCaptureEntry: bootEntry }))
page.close()
