// wiki-claude-door — one question to a model, for a farm plugin's handlers.
//
// MOVED from wiki-plugin-audionote/api/handlers.js (Plan Tool Plan, Phase 4)
// so the Voice Tool and the Plan Tool share one door rather than two copies.
// David's decision: a module both plugins import, not the audionote plugin.
//
// A caller names a MODEL, not how this farm reaches it:
//   claude-…             the Claude API where the farm holds a key, else the
//                        Claude Code CLI (door() below decides)
//   claude-cli:claude-…  the Claude Code CLI in headless mode (`claude -p`),
//                        as whoever is logged in on the farm's machine — a
//                        Claude Max account, no API key
//   ollama:name          an Ollama model, its URL found through DNS-SD
//
// The door runs wherever the handler runs: on the laptop the CLI is signed in
// to David's Max account; on a headless farm (the Pi5) it reads a long-lived
// token from a mode-600 file and hands it to the CLI. Neither is hard-coded.
//
// Settings are read when a question is asked, from CLAUDE_DOOR_* names, with
// the AUDIONOTE_* names the Voice Tool has always read as fallbacks, so a farm
// configured for audionote keeps working unchanged:
//   CLAUDE_DOOR_MODEL           AUDIONOTE_SUMMARY_MODEL      the default model
//   CLAUDE_DOOR_FALLBACK_MODEL  AUDIONOTE_FALLBACK_MODEL     tried when the first is unreachable
//   CLAUDE_DOOR_OLLAMA_URL      AUDIONOTE_OLLAMA_URL         a URL or dnssd:… spec
//   CLAUDE_DOOR_OLLAMA_FALLBACK AUDIONOTE_OLLAMA_FALLBACK    when DNS-SD fails
//   CLAUDE_DOOR_TOKEN_FILE      AUDIONOTE_CLAUDE_TOKEN_FILE  the CLI's OAuth token file
//   CLAUDE_DOOR_BIN             AUDIONOTE_CLAUDE_BIN         the claude executable
//   CLAUDE_DOOR_KEY_FILE        (new)                        the API key file
// ANTHROPIC_API_KEY, when set, is the API key.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import * as discover from './discover.js'

const home = os.homedir()

/** The first of these environment names that is set, else the default. */
const setting = (names, fallback = '') => {
  for (const n of names) if (process.env[n]) return process.env[n]
  return fallback
}

const problem = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra })
const unreachable = (status, message) => problem(status, message, { unreachable: true })

// ---------- which model ----------

/** A model id a caller may name: the test the Voice Tool applies to a prompt's MODEL line. */
export const MODEL_ID = /^(claude-[a-z0-9-]+|claude-cli:claude-[a-z0-9-]+|ollama:[\w.:/-]+)$/
export const isModelId = model => typeof model === 'string' && MODEL_ID.test(model)

/**
 * The model to ask when a caller does not say: the operator's choice per farm,
 * else the caller's own default. A laptop on the road might set
 * CLAUDE_DOOR_MODEL=ollama:gemma3:4b.
 */
export const defaultModel = (fallback = 'claude-opus-5-5') => setting(['CLAUDE_DOOR_MODEL', 'AUDIONOTE_SUMMARY_MODEL'], fallback)

/** Tried when the first choice cannot be reached (no network, no key); '' for none. */
export const fallbackModel = () => setting(['CLAUDE_DOOR_FALLBACK_MODEL', 'AUDIONOTE_FALLBACK_MODEL'], '')

// ---------- the key and the token ----------

const keyFile = () => setting(['CLAUDE_DOOR_KEY_FILE'], path.join(home, '.config', 'voice', 'anthropic-key'))
const tokenFile = () => setting(['CLAUDE_DOOR_TOKEN_FILE', 'AUDIONOTE_CLAUDE_TOKEN_FILE'], path.join(home, '.config', 'voice', 'claude-token'))

export const hasApiKey = () => !!process.env.ANTHROPIC_API_KEY || fs.existsSync(keyFile())

const apiKey = () => {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try {
    return fs.readFileSync(keyFile(), 'utf8').trim()
  } catch {
    throw problem(503, `no Claude API key on this farm — put one in ${keyFile()} (mode 600)`)
  }
}

// On a headless farm nobody is logged in interactively: a token minted once
// with `claude setup-token` is kept in a mode-600 file and handed to the CLI
// as CLAUDE_CODE_OAUTH_TOKEN — the mail-triage pattern. Where the file is
// absent the CLI's own login is used (a laptop).
const cliToken = () => {
  try {
    return fs.readFileSync(tokenFile(), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * How this farm reaches a model. A bare "claude-…" means the Claude API where
 * the farm holds a key, and the Claude Code CLI — the Max account — where it
 * does not, so one prompt works on every farm. Idempotent.
 */
export const door = model => (/^claude-(?!cli:)/.test(model) && !hasApiKey() ? `claude-cli:${model}` : model)

// ---------- filling a template ----------

/**
 * {{name}} filled from values; names with no value are left as written. When
 * values carry a transcript the template never mentions, it is appended — the
 * Voice Tool's rule: a prompt that never names the transcript still gets it.
 */
export const fill = (template, values = {}) => {
  let used = false
  const text = String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (all, name) => {
    if (name === 'transcript') used = true
    return values[name] !== undefined ? String(values[name]) : all
  })
  return used || !('transcript' in values) ? text : `${text}\n\n<transcript>\n${values.transcript}\n</transcript>`
}

// ---------- the three roads ----------

const DEFAULT_TIMEOUT_MS = 7 * 60 * 1000

let client = null
const claude = async () => {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    client = new Anthropic({ apiKey: apiKey() })
  }
  return client
}

export const askClaude = async (model, content, { system = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  let response
  try {
    response = await (await claude()).beta.messages.create(
      {
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content }],
      },
      { timeout: timeoutMs },
    )
  } catch (e) {
    throw unreachable(e.status === 401 ? 503 : 502, `Claude could not be reached: ${e.message}`)
  }
  if (response.stop_reason === 'refusal') {
    throw problem(422, `Claude declined to answer this${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}`)
  }
  return {
    markdown: response.content.filter(b => b.type === 'text').map(b => b.text).join('\n\n').trim(),
    model: response.model,
    stop: response.stop_reason,
    usage: { input: response.usage?.input_tokens, output: response.usage?.output_tokens },
  }
}

export const askOllama = async (model, content, { system = '', timeoutMs = 10 * 60 * 1000 } = {}) => {
  const name = model.slice('ollama:'.length)
  const spec = setting(['CLAUDE_DOOR_OLLAMA_URL', 'AUDIONOTE_OLLAMA_URL'], 'http://127.0.0.1:11434')
  let url = spec
  let res
  try {
    url = await discover.resolve(spec, setting(['CLAUDE_DOOR_OLLAMA_FALLBACK', 'AUDIONOTE_OLLAMA_FALLBACK'], ''))
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }]
    res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, stream: false, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw unreachable(502, `Ollama at ${url} could not be reached: ${e.message}`)
  }
  if (!res.ok) throw Object.assign(problem(502, `Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`), { unreachable: res.status === 404 })
  const body = await res.json()
  // Reasoning models (qwen3 and kin) think aloud even when asked not to, and
  // some ollama builds drop the opening <think> but keep </think>: the answer
  // is whatever follows the last </think>.
  const markdown = String(body.message?.content || '').split('</think>').pop().trim()
  return { markdown, model, stop: body.done_reason, usage: { input: body.prompt_eval_count, output: body.eval_count } }
}

/** Every tool the CLI has, disallowed: the content is untrusted text and this is one question, not an agent. */
export const NO_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Task,Agent,NotebookEdit'

/**
 * Claude through the Claude Code CLI in headless mode (`claude -p`), the house
 * pattern, as in wiki-gmap-name. CLAUDECODE is dropped so a farm started from
 * inside a Claude session does not look like a nested one. The content goes in
 * on stdin; the answer is stdout.
 */
export const askClaudeCli = (model, content, { system = '', timeoutMs = DEFAULT_TIMEOUT_MS, allowTools = false } = {}) =>
  new Promise((resolve, reject) => {
    const name = model.slice('claude-cli:'.length)
    const env = { ...process.env }
    delete env.CLAUDECODE
    const token = cliToken()
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
    const bin = setting(['CLAUDE_DOOR_BIN', 'AUDIONOTE_CLAUDE_BIN'], 'claude')
    const args = ['-p', '--model', name]
    if (!allowTools) args.push('--disallowedTools', NO_TOOLS)
    if (system) args.push('--append-system-prompt', system)
    const child = spawn(bin, args, { env, cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    let settled = false
    const timer = setTimeout(() => {
      // Answer now: a grandchild still holding the pipes would delay close.
      settled = true
      child.kill('SIGKILL')
      reject(problem(504, `the claude CLI took longer than ${Math.round(timeoutMs / 1000)}s and was stopped`))
    }, timeoutMs)
    child.on('error', e => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      reject(unreachable(502, `the claude CLI could not be started (${bin}): ${e.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const text = out.trim()
      if (code !== 0 || !text || /^Not logged in/i.test(text)) {
        const why = (text || err.trim()).split('\n').slice(-2).join(' ').slice(0, 300) || `exit ${code}`
        return reject(unreachable(502, `the claude CLI did not answer: ${why}`))
      }
      resolve({ markdown: text, model, stop: 'end_turn', usage: {} })
    })
    child.stdin.on('error', () => {}) // a CLI that exits before reading its input is reported by close
    child.stdin.end(content)
  })

/**
 * Ask one question. `model` is any MODEL_ID; a bare claude-… goes through
 * door() first. Answers {markdown, model, stop, usage, ms}; a failure throws
 * an Error with a status, and `unreachable` set when another model might do.
 * allowTools applies to the CLI only, and is off unless asked for.
 */
export const ask = async (model, content, opts = {}) => {
  const how = door(model)
  const t0 = Date.now()
  const out = how.startsWith('ollama:')
    ? await askOllama(how, content, opts)
    : how.startsWith('claude-cli:')
      ? await askClaudeCli(how, content, opts)
      : await askClaude(how, content, opts)
  return { ...out, ms: Date.now() - t0 }
}

export { discover }
