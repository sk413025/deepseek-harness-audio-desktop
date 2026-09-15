// Shared packaged-app UI steps for the macOS phases (desktop-smoke bundled, desktop-availability).
// The only OS-level substitution is the workspace folder chooser: the Desktop host runs `osascript choose folder`, and a
// PATH shim answers exactly that call with the test workspace; every other osascript call passes through.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitUntil } from './cdp.mjs'

/** Create the osascript shim; returns { dir, log } — prepend dir to the app's PATH. */
export function createFolderChooserShim({ workDir, workspace, logFile }) {
  const dir = join(workDir, 'os-dialog-shim')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'osascript'), `#!/bin/sh\ncase "$*" in *"choose folder"*) echo "$(date +%s) choose-folder $*" >> "${logFile}"; printf '%s/\\n' "${workspace}"; exit 0 ;; esac\nexec /usr/bin/osascript "$@"\n`, { mode: 0o755 })
  return { dir, log: logFile }
}

export async function dismissFirstRunDialogs(page, note = () => {}) {
  for (const [text, button] of [['Internal Testing Notice', /^Continue$/], ['Add an API key to get started', /^Configure later$/]]) {
    const dialog = page.getByText(text)
    await dialog.waitFor({ state: 'visible', timeout: 4_000 }).catch(() => undefined)
    if (await dialog.count() > 0) {
      await page.getByRole('button', { name: button }).click({ timeout: 10_000 }).catch(() => undefined)
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined)
      note(`dismissed first-run dialog: ${text}`)
    }
  }
}

/** "Choose workspace" → "Add workspace…" (or the hero textbox) → shimmed OS chooser → composer enabled. */
export async function chooseWorkspace(page, shimLog) {
  const choose = page.getByRole('button', { name: /Choose workspace/i }).or(page.getByText(/^Choose workspace$/)).first()
  await choose.click({ timeout: 30_000 })
  const addWorkspace = page.getByText(/Add workspace/i).first()
  if (await addWorkspace.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false)) await addWorkspace.click()
  else await page.locator('[role=textbox]').last().click().catch(() => undefined)
  const ready = await waitUntil('hero composer enabled for the chosen workspace', async () => page.evaluate(() => {
    const box = [...document.querySelectorAll('[role=textbox]')].at(-1)
    return box !== undefined && !/Choose a workspace/i.test(box.getAttribute('aria-label') ?? '') ? (box.getAttribute('aria-label') ?? 'ready') : null
  }), { timeoutMs: 30_000, intervalMs: 300 }).catch(() => null)
  const shimCalls = existsSync(shimLog) ? readFileSync(shimLog, 'utf8').trim().split('\n').filter(Boolean).length : 0
  await page.keyboard.press('Escape').catch(() => undefined)
  return { ready: ready?.value ?? null, shimCalls }
}
