#!/usr/bin/env node
/**
 * Regenerate the marketplace screenshots (assets/screenshot-*.png) from a live
 * DSH web UI. The plugin's panel is rendered by the running server, so this
 * script drives a headless Chromium over the DevTools protocol instead of
 * drawing anything itself — the images are real renders of the real panel.
 *
 *   node tools/capture-screenshots.mjs
 *
 * Environment overrides:
 *   DSHTB_URL     app URL                (default http://127.0.0.1:3080)
 *   DSHTB_CHROME  chromium executable    (default Chrome on Windows)
 *   DSHTB_OUT     output directory       (default <repo>/assets)
 *   DSHTB_PORT    DevTools port          (default 9222)
 *
 * The script only reads the page. It never clicks a control that writes to the
 * board, so running it cannot change anybody's tasks. The only state it sets is
 * the panel's localStorage geometry, in a throwaway browser profile.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.DSHTB_OUT ? resolve(process.env.DSHTB_OUT) : join(ROOT, 'assets')
const APP = process.env.DSHTB_URL ?? 'http://127.0.0.1:3080'
const PORT = Number(process.env.DSHTB_PORT ?? 9222)
const CHROME =
  process.env.DSHTB_CHROME ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = join(tmpdir(), 'dshtb-shot-profile')
const VIEW = { width: 1440, height: 900 }
const LAYOUT_KEY = 'dsh.todoBoard.layout.v1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function jsonOverHttp(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`)
      if (res.ok) return await res.json()
      last = `HTTP ${res.status}`
    } catch (err) {
      last = err.message
    }
    await sleep(250)
  }
  throw new Error(`DevTools endpoint :${PORT}${path} unreachable: ${last}`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      const waiter = msg.id === undefined ? undefined : this.pending.get(msg.id)
      if (waiter === undefined) return
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(`${msg.error.message} (${waiter.method})`))
      else waiter.resolve(msg.result)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve_, reject) => {
      ws.addEventListener('open', resolve_, { once: true })
      ws.addEventListener('error', () => reject(new Error('DevTools websocket failed')), {
        once: true,
      })
    })
    return new Cdp(ws)
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq
    return new Promise((resolve_, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve_(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      const text =
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'unknown'
      throw new Error(`evaluate failed: ${text}`)
    }
    return res.result?.value
  }

  async screenshot(file, clip) {
    const params = { format: 'png' }
    if (clip) {
      params.clip = clip
      params.captureBeyondViewport = true
    }
    const { data } = await this.send('Page.captureScreenshot', params)
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }
}

/** Poll until the todo panel is in the DOM, or give up with diagnostics. */
async function waitForPanel(cdp, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await cdp
      .evaluate("!!document.querySelector('.dshtb-root')")
      .catch(() => false)
    if (found) return true
    await sleep(500)
  }
  return false
}

async function main() {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${PORT}`,
      `--window-size=${VIEW.width},${VIEW.height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    const version = await jsonOverHttp('/json/version')
    const targets = await jsonOverHttp('/json/list')
    const page = targets.find((t) => t.type === 'page')
    if (page === undefined) throw new Error('no page target in Chromium')

    const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.width,
      height: VIEW.height,
      deviceScaleFactor: 1,
      mobile: false,
    })

    // First pass: seed the panel geometry, so the shot does not depend on CSS
    // defaults (and never writes anything back to the board).
    await cdp.send('Page.navigate', { url: APP })
    await sleep(2000)
    await cdp.evaluate(
      `(() => {
         const w = 520, h = 660
         const x = Math.max(8, window.innerWidth - w - 28), y = 24
         localStorage.setItem(${JSON.stringify(LAYOUT_KEY)}, JSON.stringify({ x, y, w, h }))
         return true
       })()`,
    )
    await cdp.send('Page.reload', { ignoreCache: false })

    if (!(await waitForPanel(cdp))) {
      mkdirSync(OUT, { recursive: true })
      const debug = {
        url: APP,
        title: await cdp.evaluate('document.title').catch(() => ''),
        text: await cdp
          .evaluate('(document.body && document.body.innerText || "").slice(0, 1500)')
          .catch(() => ''),
        html: await cdp
          .evaluate('(document.body && document.body.innerHTML || "").slice(0, 2000)')
          .catch(() => ''),
      }
      writeFileSync(join(OUT, 'capture-debug.json'), JSON.stringify(debug, null, 2))
      await cdp.screenshot(join(OUT, 'capture-debug.png')).catch(() => {})
      throw new Error(`panel .dshtb-root never appeared — see ${join(OUT, 'capture-debug.json')}`)
    }

    // Let the client finish its first data fetch and the entry animation.
    await sleep(2500)
    mkdirSync(OUT, { recursive: true })

    const wide = await cdp.screenshot(join(OUT, 'screenshot-1.png'))
    const rect = await cdp.evaluate(
      `(() => {
         const el = document.querySelector('.dshtb-root')
         const r = el.getBoundingClientRect()
         return {
           x: Math.max(0, Math.floor(r.x - 10)),
           y: Math.max(0, Math.floor(r.y - 10)),
           width: Math.ceil(r.width + 20),
           height: Math.ceil(r.height + 20),
         }
       })()`,
    )
    const detail = await cdp.screenshot(join(OUT, 'screenshot-2.png'), { ...rect, scale: 2 })

    console.log(
      JSON.stringify(
        {
          ok: true,
          browser: version.Browser,
          url: APP,
          title: await cdp.evaluate('document.title'),
          panel: rect,
          files: [wide, detail],
        },
        null,
        2,
      ),
    )
  } finally {
    chrome.kill()
  }
}

main().catch((err) => {
  console.error('capture failed: ' + (err && err.stack ? err.stack : err))
  process.exitCode = 1
})
