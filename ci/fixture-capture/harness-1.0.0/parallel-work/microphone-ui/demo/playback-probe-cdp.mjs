#!/usr/bin/env node
// Install or read the passive playback probe in a running DeepSeek Harness page over CDP.
//
// Usage:
//   node playback-probe-cdp.mjs <cdpPort> install [sessionId…]   install and tap the host audio feed of these Sessions
//   node playback-probe-cdp.mjs <cdpPort> sessions               list Session ids visible in the page URL/sidebar links
//   node playback-probe-cdp.mjs <cdpPort> read <out.json>        write the full timeline + per-stream summary
//   node playback-probe-cdp.mjs <cdpPort> uninstall
// The page must be the app page (`dsh-app://` in Desktop, http(s) in Web). Nothing here clicks or sends.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attach } from '../e2e/cdp-lib.mjs'

const [port, command, ...rest] = process.argv.slice(2)
if (!port || !command) {
  console.error('usage: playback-probe-cdp.mjs <cdpPort> install|sessions|read|uninstall …')
  process.exit(2)
}
const page = await attach(Number(port), url => url.startsWith('dsh-app://') || url.startsWith('http://') || url.startsWith('https://'))
try {
  if (command === 'install') {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'playback-probe.page.js'), 'utf8')
    console.log(JSON.stringify(await page.evaluate(source)))
    for (const sessionId of rest) console.log(`tap ${sessionId}:`, await page.evaluate(`globalThis.__dshPlaybackProbe.tapFeed(${JSON.stringify(sessionId)})`))
  } else if (command === 'sessions') {
    console.log(JSON.stringify(await page.evaluate(`(() => {
      const ids = new Set()
      const scan = (text) => { for (const m of String(text).matchAll(/sessions?[/=]([A-Za-z0-9_-]{6,})/g)) ids.add(m[1]) }
      scan(location.href)
      for (const a of document.querySelectorAll('a[href]')) scan(a.getAttribute('href'))
      return { location: location.href, ids: [...ids] }
    })()`), null, 2))
  } else if (command === 'read') {
    const out = rest[0]
    const data = await page.evaluate('globalThis.__dshPlaybackProbe ? globalThis.__dshPlaybackProbe.read() : null')
    if (data === null) throw new Error('probe not installed (a page reload removes it)')
    if (out) writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`)
    console.log(JSON.stringify(data.streams, null, 2))
  } else if (command === 'uninstall') {
    console.log(await page.evaluate('globalThis.__dshPlaybackProbe ? globalThis.__dshPlaybackProbe.uninstall() : false'))
  } else {
    throw new Error(`unknown command ${command}`)
  }
} finally {
  page.close()
}
