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
//   openai:name          (0.2.0) a model behind an OpenAI-compatible
//                        /v1/chat/completions, its URL found through DNS-SD
//                        (default coop._openai._tcp.names.private.fish: the
//                        LLM coop's GPU machine on the tailnet, 17 Oct 2026)
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
//   CLAUDE_DOOR_OPENAI_URL      (0.2.0)                      a URL or dnssd:… spec for openai:
//   CLAUDE_DOOR_OPENAI_FALLBACK (0.2.0)                      when DNS-SD fails
//   CLAUDE_DOOR_TOKEN_FILE      AUDIONOTE_CLAUDE_TOKEN_FILE  the CLI's OAuth token file
//   CLAUDE_DOOR_BIN             AUDIONOTE_CLAUDE_BIN         the claude executable
//   CLAUDE_DOOR_KEY_FILE        (new)                        the API key file
//   CLAUDE_DOOR_SCOPE_MEMORY    (0.1.1)                      the CLI's own memory cap, or off
//   CLAUDE_DOOR_SYSTEMD_RUN     (0.1.1)                      the systemd-run executable
//   CLAUDE_DOOR_AUTO_LIGHT      (0.4.0)                      the coop model Auto's light tier asks, default openai:llm_auto-big
//   CLAUDE_DOOR_AUTO_BIG        (0.4.0)                      the Claude model Auto's big tier asks, default claude-fable-5-1
//   CLAUDE_DOOR_CLASSIFIER      (0.5.0)                      the coop model the classifier call asks (it must be loaded), default the router's target; off = no classifier call
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
export const MODEL_ID = /^(claude-[a-z0-9-]+|claude-cli:claude-[a-z0-9-]+|ollama:[\w.:/-]+|openai:[\w.:/-]+)$/
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

// ---------- how big a question is (0.2.1) ----------
//
// About 3.5 characters a token for English markdown: an estimate, used to
// size an Ollama context and to refuse a question a model cannot hold, never
// to bill anything.
export const estimateTokens = text => Math.ceil(String(text || '').length / 3.5)

// Ollama answers with its own small default context (2048–4096 tokens) unless
// told otherwise, and drops the START of a longer prompt without a word — a
// plan's context is often ~30k tokens. So every call names num_ctx: the
// question plus room to answer, at least 4096, at most CLAUDE_DOOR_OLLAMA_NUM_CTX
// (default 32768, which qwen3 holds).
export const ollamaContext = (content, system = '', answer = 4096) => {
  const most = +setting(['CLAUDE_DOOR_OLLAMA_NUM_CTX'], '32768') || 32768
  return Math.min(most, Math.max(4096, estimateTokens(system) + estimateTokens(content) + answer))
}

export const askOllama = async (model, content, { system = '', timeoutMs = 10 * 60 * 1000 } = {}) => {
  const name = model.slice('ollama:'.length)
  // found by name (qwen lives on the MacMini, never hard-coded), localhost when DNS-SD fails (0.2.0)
  const spec = setting(['CLAUDE_DOOR_OLLAMA_URL', 'AUDIONOTE_OLLAMA_URL'], 'dnssd:qwen._ollama._tcp.names.private.fish')
  let url = spec
  let res
  try {
    url = await discover.resolve(spec, setting(['CLAUDE_DOOR_OLLAMA_FALLBACK', 'AUDIONOTE_OLLAMA_FALLBACK'], 'http://127.0.0.1:11434'))
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }]
    res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, stream: false, messages, options: { num_ctx: ollamaContext(content, system) } }),
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

// ---------- an OpenAI-compatible endpoint (0.2.0) ----------
//
// The LLM coop's machine (llama-swap in front of vLLM) and anything like it.
// Reasoning models (glm-5.3-flash behind llm_auto-big) think first, into
// message.reasoning: with a small max_tokens the answer comes back empty, and
// switching thinking off makes glm write its reasoning INTO the answer
// (measured 17 Oct 2026) — so thinking stays on and the budget is large.

export const askOpenAI = async (model, content, { system = '', timeoutMs = 10 * 60 * 1000, maxTokens = 0, temperature = 0.2 } = {}) => {
  const name = model.slice('openai:'.length)
  const spec = setting(['CLAUDE_DOOR_OPENAI_URL'], 'dnssd:coop._openai._tcp.names.private.fish')
  let url = spec
  let res
  try {
    url = (await discover.resolve(spec, setting(['CLAUDE_DOOR_OPENAI_FALLBACK'], ''))).replace(/\/v1$/, '')
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }]
    res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // the answer AND the thinking come out of max_tokens: a redraft of a long plan needs more than 8000 (0.2.1)
      body: JSON.stringify({ model: name, messages, temperature, max_tokens: maxTokens || +setting(['CLAUDE_DOOR_MAX_TOKENS'], '8000') || 8000 }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw unreachable(502, `the model at ${url} could not be reached: ${e.message}`)
  }
  if (!res.ok) {
    throw Object.assign(problem(502, `${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`), { unreachable: res.status >= 500 || res.status === 404 })
  }
  const body = await res.json()
  const choice = body.choices?.[0] || {}
  const markdown = String(choice.message?.content || '').split('</think>').pop().trim()
  if (!markdown) throw unreachable(502, `${name} gave no answer (${choice.finish_reason || 'empty'})`)
  if (choice.finish_reason === 'length') throw problem(502, `${name} ran out of room before it finished (max_tokens ${maxTokens || setting(['CLAUDE_DOOR_MAX_TOKENS'], '8000')}): the answer was cut short`)
  return {
    markdown,
    model: `openai:${body.model || name}`,
    stop: choice.finish_reason,
    usage: { input: body.usage?.prompt_tokens, output: body.usage?.completion_tokens, reasoning: body.usage?.completion_tokens_details?.reasoning_tokens },
  }
}

// ---------- the CLI's own scope (0.1.1) ----------
//
// On a farm run by systemd (the Pi5), the CLI is a child of the wiki farm and
// so counts against the farm's own memory cap: a farm near its MemoryMax plus
// a `claude -p` of a few hundred MB is an OOM kill of the whole farm, not of
// the one question (17 Oct 2026: the private farm at 1.78 of 2.0 GB). So
// there the CLI runs in a transient scope of its own, `systemd-run --user
// --scope`, with its own MemoryMax and no swap: outside the farm's cgroup, and
// when it is too big it alone is killed and the question fails with a 502.
//
//   CLAUDE_DOOR_SCOPE_MEMORY  unset — a scope of SCOPE_DEFAULT when the door
//                             runs under a systemd unit on Linux (INVOCATION_ID
//                             is set), none elsewhere (a laptop);
//                             a size (800M, 1G) — a scope of that size, always;
//                             off — never a scope.
//   CLAUDE_DOOR_SYSTEMD_RUN   the systemd-run executable, systemd-run by default.

export const SCOPE_DEFAULT = '1G'
const SIZE_RE = /^\d+(?:\.\d+)?[KMGT]?$/

/**
 * The words that put a command in its own scope, or null for none: decided
 * from the setting, the platform and whether systemd started this process.
 * Pure, so the rule can be tested anywhere.
 */
export const scopeArgs = ({ setting: want = '', platform = process.platform, underSystemd = !!process.env.INVOCATION_ID, run = 'systemd-run', unit = '' } = {}) => {
  const v = String(want || '').trim()
  if (/^(off|none|no|0)$/i.test(v)) return null
  if (v && !SIZE_RE.test(v)) throw problem(500, `CLAUDE_DOOR_SCOPE_MEMORY must be a size such as 800M or 1G, or off; it is ${v}`)
  if (!v && !(platform === 'linux' && underSystemd)) return null
  const cap = v || SCOPE_DEFAULT
  return { cap, run, args: ['--user', '--scope', '--quiet', '--collect', ...(unit ? [`--unit=${unit}`] : []), '-p', `MemoryMax=${cap}`, '-p', 'MemorySwapMax=0', '--'] }
}

/** Every tool the CLI has, disallowed: the content is untrusted text and this is one question, not an agent. */
export const NO_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Task,Agent,NotebookEdit'

/**
 * The tools a question may be given (0.1.2): reading the web, nothing that
 * runs a command or touches a file. A caller asks for some of these with
 * `tools`; the CLI is then offered exactly those (--tools), they are
 * approved for a headless run (--allowedTools), and every other tool stays
 * disallowed.
 */
export const RESEARCH_TOOLS = ['WebSearch', 'WebFetch']

export const toolArgs = ({ tools = null, allowTools = false } = {}) => {
  if (Array.isArray(tools) && tools.length) {
    const bad = tools.filter(t => !RESEARCH_TOOLS.includes(t))
    if (bad.length) throw problem(500, `the door gives a model only ${RESEARCH_TOOLS.join(' and ')}, not ${bad.join(', ')}`)
    const list = tools.join(',')
    const rest = NO_TOOLS.split(',').filter(t => !tools.includes(t)).join(',')
    return ['--tools', list, '--allowedTools', list, '--disallowedTools', rest]
  }
  return allowTools ? [] : ['--disallowedTools', NO_TOOLS]
}

/**
 * Claude through the Claude Code CLI in headless mode (`claude -p`), the house
 * pattern, as in wiki-gmap-name. CLAUDECODE is dropped so a farm started from
 * inside a Claude session does not look like a nested one. The content goes in
 * on stdin; the answer is stdout.
 */
export const askClaudeCli = (model, content, { system = '', timeoutMs = DEFAULT_TIMEOUT_MS, allowTools = false, tools = null } = {}) =>
  new Promise((resolve, reject) => {
    const name = model.slice('claude-cli:'.length)
    const env = { ...process.env }
    delete env.CLAUDECODE
    const token = cliToken()
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
    const bin = setting(['CLAUDE_DOOR_BIN', 'AUDIONOTE_CLAUDE_BIN'], 'claude')
    const args = ['-p', '--model', name]
    try {
      args.push(...toolArgs({ tools, allowTools }))
    } catch (e) {
      return reject(e)
    }
    if (system) args.push('--append-system-prompt', system)
    let scope
    try {
      scope = scopeArgs({ setting: setting(['CLAUDE_DOOR_SCOPE_MEMORY'], ''), run: setting(['CLAUDE_DOOR_SYSTEMD_RUN'], 'systemd-run'), unit: `claude-door-${process.pid}-${Date.now().toString(36)}` })
    } catch (e) {
      return reject(e)
    }
    const child = scope ? spawn(scope.run, [...scope.args, bin, ...args], { env, cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] }) : spawn(bin, args, { env, cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
    const where = scope ? ` in its own scope (MemoryMax=${scope.cap}, no swap)` : ''
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
      reject(unreachable(502, `the claude CLI could not be started (${scope ? `${scope.run} … ${bin}` : bin}): ${e.message}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const text = out.trim()
      // Killed from outside: in a scope, most likely its memory cap.
      if (signal === 'SIGKILL' || code === 137) return reject(unreachable(502, `the claude CLI was killed${where}${scope ? ': it went over its memory cap' : ''}`))
      if (scope && code !== 0 && !text && /Failed to (start|connect|create)|transient/i.test(err)) {
        return reject(unreachable(502, `the claude CLI could not be put in its own scope: ${err.trim().split('\n').pop().slice(0, 200)} — set CLAUDE_DOOR_SCOPE_MEMORY=off to run it without one`))
      }
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
 * allowTools applies to the CLI only, and is off unless asked for; tools
 * (0.1.2) gives the CLI some of RESEARCH_TOOLS and nothing else. The API road
 * has no tools: a question that needs them goes by the CLI.
 */
export const ask = async (model, content, opts = {}) => {
  const how = door(model)
  const t0 = Date.now()
  const out = how.startsWith('ollama:')
    ? await askOllama(how, content, opts)
    : how.startsWith('openai:')
      ? await askOpenAI(how, content, opts)
    : how.startsWith('claude-cli:')
      ? await askClaudeCli(how, content, opts)
      : await askClaude(how, content, opts)
  return { ...out, ms: Date.now() - t0 }
}

// ---------- what each door can reach, now (0.2.1) ----------
//
// For a settings page: the Claude models this farm reaches (by its API key or
// the CLI's login), the OpenAI-compatible endpoint's text models (the coop:
// context window, loaded or cold, reasoning) and the Ollama models. Each door
// is asked live, briefly; a door that does not answer is listed with why.
// Remembered for a minute, so a page that asks twice asks once.
let listed = null
export const listModels = async ({ timeoutMs = 4000, fresh = false } = {}) => {
  if (!fresh && listed && Date.now() - listed.at < 60 * 1000) return listed.value
  const get = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`${url} answered ${res.status}`)
    return res.json()
  }
  const claude = {
    door: 'claude',
    route: hasApiKey() ? 'the Claude API, by this farm\'s key' : 'the Claude Code CLI, on the login of the machine the farm runs on',
    models: [['claude-fable-5-1', 'Claude Fable 5.1'], ['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5']].map(([id, name]) => ({ id, name, contextLength: 200000, tools: true })),
  }
  const openai = { door: 'openai', models: [] }
  try {
    const spec = setting(['CLAUDE_DOOR_OPENAI_URL'], 'dnssd:coop._openai._tcp.names.private.fish')
    const url = (await discover.resolve(spec, setting(['CLAUDE_DOOR_OPENAI_FALLBACK'], ''))).replace(/\/v1$/, '')
    openai.url = url
    const body = await get(`${url}/v1/models`)
    openai.models = (body.data || [])
      .filter(m => /^llm_/.test(m.id))
      .map(m => {
        const swap = m.meta?.llamaswap || {}
        return {
          id: `openai:${m.id}`,
          name: m.name || m.id,
          description: m.description || '',
          contextLength: m.context_length || m.context_window || null,
          selector: swap.type === 'selector',
          targets: swap.targets || [],
          reasoning: !!swap.reasoning,
          loaded: m.status?.value === 'loaded',
        }
      })
  } catch (e) {
    openai.error = e.message
  }
  const ollama = { door: 'ollama', models: [] }
  try {
    const spec = setting(['CLAUDE_DOOR_OLLAMA_URL', 'AUDIONOTE_OLLAMA_URL'], 'dnssd:qwen._ollama._tcp.names.private.fish')
    const url = await discover.resolve(spec, setting(['CLAUDE_DOOR_OLLAMA_FALLBACK', 'AUDIONOTE_OLLAMA_FALLBACK'], 'http://127.0.0.1:11434'))
    ollama.url = url
    const body = await get(`${url}/api/tags`)
    const most = +setting(['CLAUDE_DOOR_OLLAMA_NUM_CTX'], '32768') || 32768
    ollama.models = (body.models || []).map(m => ({ id: `ollama:${m.name}`, name: m.name, size: m.size, contextLength: most }))
  } catch (e) {
    ollama.error = e.message
  }
  // A selector (llm_auto-big: "whichever big model is already loaded") routes
  // to a loaded target when there is one, so its window is that target's now;
  // with none loaded it cold-starts the first, and promises only the smallest.
  for (const m of openai.models.filter(x => x.selector)) {
    const targets = m.targets.map(t => openai.models.find(x => x.id === `openai:${t}`)).filter(Boolean)
    const warm = targets.find(t => t.loaded)
    m.routesTo = warm ? warm.id : targets[0]?.id || null
    const windows = targets.map(t => t.contextLength).filter(Boolean)
    m.contextLength = warm?.contextLength || (windows.length ? Math.min(...windows) : null)
  }
  listed = { at: Date.now(), value: { doors: [openai, claude, ollama] } }
  return listed.value
}

/** A model's context window, if a door says (null when unknown). */
export const contextOf = async model => {
  const { doors } = await listModels()
  for (const d of doors) {
    const m = d.models.find(x => x.id === model || `claude-cli:${x.id}` === model)
    if (m) return m.contextLength || null
  }
  return null
}

// ---------- Auto: a tier to a model (0.3.0, rule changed in 0.4.0) ----------
//
// A caller that lets the farm choose (the Plan Tool's and the Voice Tool's
// "auto") decides how hard its question is — a tier — and the door turns the
// tier into a model it can reach now, one whose window holds the question
// plus room to answer. David's rule (20 Oct 2026): we route the big runs to
// Claude ourselves, and hand the small ones to the coop, whose own auto
// routing picks the model for its hardware.
//   light    the coop's router, CLAUDE_DOOR_AUTO_LIGHT, else openai:llm_auto-big
//            (whichever big model is loaded); when it cannot hold the
//            question, the coop model with the largest window that can
//   big      Claude: CLAUDE_DOOR_AUTO_BIG, else claude-fable-5-1; too big for
//            Claude's window, the coop model with the largest window
//   careful  the same as big (0.3.0 callers)
// The coop down or nothing there holds a light question: Claude, and the
// reason says so. Too big for every window: no model, and the reason says why.
// Pure over listModels' answer, so the rule is tested without a network.

const AUTO_ANSWER = 4096
export const AUTO_TIERS = ['light', 'big', 'careful']
export const AUTO_LIGHT = 'openai:llm_auto-big'
export const AUTO_BIG = 'claude-fable-5-1'

/** A model id, short, for a status line: openai:llm_glm-5.3-flash-pp → glm-5.3-flash-pp, claude-cli:claude-opus-5-5 → claude-opus-5-5. */
export const shortModel = id => String(id || '').replace(/^(openai:llm_|openai:|ollama:|claude-cli:)/, '')

/** About 34k: a token count, short. */
export const tokensLabel = n => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export const autoModel = ({ tier = 'light', need = 0, doors = [], answer = AUTO_ANSWER, light = '', big = '' } = {}) => {
  if (!AUTO_TIERS.includes(tier)) throw problem(400, `auto tiers are ${AUTO_TIERS.join(', ')}, not ${tier}`)
  const holds = m => !!m && !!m.contextLength && m.contextLength >= need + answer
  const coopDoor = doors.find(d => d.door === 'openai') || { models: [], error: 'no coop door' }
  const coop = coopDoor.models
  const claudeDoor = doors.find(d => d.door === 'claude') || { models: [] }
  const claudeId = big || setting(['CLAUDE_DOOR_AUTO_BIG'], AUTO_BIG)
  const claudeModel = claudeDoor.models.find(m => m.id === claudeId) || (claudeDoor.models.length ? { id: claudeId, contextLength: 200000 } : null)
  const pick = (m, t, note = '') => ({ model: m.id, tier: t, asked: tier, contextLength: m.contextLength || null, loaded: m.loaded === true, note })
  const routes = m => (m.selector && m.routesTo ? `routes to ${shortModel(m.routesTo)}` : '')
  const join = (...notes) => notes.filter(Boolean).join('; ')

  // the coop model with the largest window that holds it: loaded first among equals, vision last
  const roomiest = () => coop.filter(m => !m.selector && holds(m)).sort((a, b) => b.contextLength - a.contextLength || (b.loaded === true) - (a.loaded === true) || /vision/.test(a.id) - /vision/.test(b.id))[0]

  if (tier === 'big' || tier === 'careful') {
    if (holds(claudeModel)) return pick(claudeModel, 'big')
    const m = roomiest()
    if (m) return pick(m, 'light', join("too big for Claude's window", m.loaded ? '' : 'cold — it loads first'))
    return { model: '', tier: 'big', asked: tier, note: "too big for Claude's window and for every coop model" }
  }

  const router = coop.find(m => m.id === (light || setting(['CLAUDE_DOOR_AUTO_LIGHT'], AUTO_LIGHT)))
  if (holds(router)) return pick(router, 'light', routes(router))
  const m = roomiest()
  if (m) return pick(m, 'light', join(router ? `${shortModel(router.id)} cannot hold it` : '', m.loaded ? '' : 'cold — it loads first'))
  const why = coopDoor.error || !coop.length ? `the coop did not answer (${coopDoor.error || 'no models'})` : 'no coop model holds it'
  return holds(claudeModel) ? pick(claudeModel, 'big', why) : { model: '', tier: 'light', asked: tier, note: `${why}, and it is too big for Claude's window as well` }
}

// ---------- the classifier call (0.5.0) ----------
//
// The deterministic rule (autoTier in the Plan Tool, voiceTier in the Voice
// Tool) reads sizes and counts the farm already has. The classifier call reads
// a short SUMMARY of the run — its kind, its measures, the questions going
// in, the plan's opening — on a coop model that is already loaded, and says
// light or big with a reason, before the real call. Its tokens are spent on
// the coop (Auto Model Plan, Phase 6: assume it is worth them, measure in
// Phase 7). It never cold-starts a model for a classification: no coop model
// loaded, the coop down, a timeout, or an answer that is neither word, and it
// returns tier null with `skipped` saying why, so the rule stands. Pure
// enough to test: `doors` and `asker` can be given.

export const CLASSIFIER_SYSTEM =
  'You sort one run of a federated wiki Plan Tool into a tier before it is sent to a language model. ' +
  'The runs: Revise Plan redrafts one plan page from the answers to its questions; Do Next Phase writes a report on one phase; ' +
  'Revise Site revises every page of a site; Go Ahead amends, rewrites or newly writes one page. ' +
  'Two tiers. big: a long question (over 48k tokens); four or more answered questions to weave in; a whole site (Revise Site); ' +
  'Go Ahead with the action Rewrite, or on the plan itself; or a Revise Plan whose answers reach into many open phases (about twelve: answers plus half the open phases plus the questions asked back). ' +
  'light: everything smaller — a Revise Plan of a plan with few answers and few open phases, however many phases it has; an amendment; a small new page; the next phase of a plan. ' +
  'An ordinary Revise Plan is light: redrafting the plan page is what every Revise Plan does, not a reason for big. ' +
  'Read the summary and answer with exactly one line, "light: reason" or "big: reason", the reason under twenty words. No other words.'
export const CLASSIFIER_TIMEOUT_MS = 20 * 1000 // median 2.3 s, p90 7 s on the coop; a summary that sets the model ruminating is cut here and the rule stands
export const CLASSIFIER_MAX_TOKENS = 6000 // a reasoning model thinks first (glm: ~250 tokens, once in 29 past 2500), then one line; the timeout is the real bound

/** The one line a classifier answers, read: {tier: 'light'|'big'|null, reason, raw}. */
export const parseTier = text => {
  const s = String(text || '')
    .split('</think>')
    .pop()
    .replace(/^[\s*_`#>"'-]+/, '')
    .trim()
  const m = s.match(/^(light|big)\b[\s*_`"':：—–-]*([^\n]*)/i)
  if (!m) return { tier: null, reason: '', raw: s.slice(0, 200) }
  return { tier: m[1].toLowerCase(), reason: m[2].replace(/[*_`"']+$/, '').trim().slice(0, 200), raw: s.slice(0, 200) }
}

/** The loaded coop model a classification goes to, or null with no cold start: a named one (CLAUDE_DOOR_CLASSIFIER) if loaded, else the router's loaded target, else any loaded text model, a plain one before a reasoning one. */
export const classifierModel = (doors = [], want = '') => {
  const name = want || setting(['CLAUDE_DOOR_CLASSIFIER'], '')
  if (name === 'off') return null
  const coop = (doors.find(d => d.door === 'openai') || { models: [] }).models
  if (name) {
    const m = coop.find(x => x.id === name || x.id === `openai:${name}` || x.id === `openai:llm_${name}`)
    return m && m.loaded === true ? m : null
  }
  const router = coop.find(m => m.selector && m.routesTo)
  const target = router && coop.find(m => m.id === router.routesTo)
  if (target && target.loaded === true) return target
  return coop.filter(m => !m.selector && m.loaded === true && !/vision/.test(m.id)).sort((a, b) => (a.reasoning === true) - (b.reasoning === true))[0] || null
}

/**
 * The classifier's tier for a run: {tier, reason, model, ms, usage}, or
 * {tier: null, skipped, model?, ms} when it did not decide. Never throws.
 */
export const classifyTier = async ({ summary = '', doors = null, model = '', timeoutMs = CLASSIFIER_TIMEOUT_MS, maxTokens = CLASSIFIER_MAX_TOKENS, asker = askOpenAI } = {}) => {
  const t0 = Date.now()
  const ms = () => Date.now() - t0
  if (!model && setting(['CLAUDE_DOOR_CLASSIFIER'], '') === 'off') return { tier: null, skipped: 'CLAUDE_DOOR_CLASSIFIER is off', ms: 0 }
  if (!String(summary).trim()) return { tier: null, skipped: 'no summary of the run to read', ms: 0 }
  let list = doors
  if (!list) {
    try {
      list = (await listModels()).doors
    } catch (e) {
      return { tier: null, skipped: `the doors could not be listed: ${e.message}`, ms: ms() }
    }
  }
  const m = classifierModel(list, model)
  if (!m) {
    const coop = list.find(d => d.door === 'openai') || {}
    const want = model || setting(['CLAUDE_DOOR_CLASSIFIER'], '')
    return { tier: null, skipped: coop.error ? `the coop did not answer (${coop.error})` : want ? `${want} is not loaded on the coop` : 'no coop model is loaded', ms: ms() }
  }
  try {
    const out = await asker(m.id, `Summary of the run:\n\n${String(summary).slice(0, 12000)}`, { system: CLASSIFIER_SYSTEM, timeoutMs, maxTokens, temperature: 0 }) // the same summary, the same word
    const p = parseTier(out.markdown)
    if (!p.tier) return { tier: null, model: out.model || m.id, skipped: `the classifier said neither light nor big: ${p.raw}`, ms: ms(), usage: out.usage }
    return { tier: p.tier, reason: p.reason, model: out.model || m.id, ms: ms(), usage: out.usage }
  } catch (e) {
    return { tier: null, model: m.id, skipped: `the classifier call failed: ${e.message}`, ms: ms() }
  }
}

export { discover }
