// The parts of the door that need no network and no model: filling, which
// road a model takes, settings with their AUDIONOTE_* fallbacks, DNS-SD
// parsing, and the CLI road end to end against a stand-in `claude`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { fill, door, defaultModel, fallbackModel, isModelId, ask, NO_TOOLS, discover, scopeArgs, SCOPE_DEFAULT, toolArgs } from '../index.js'

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'door-test-'))
const clean = () => {
  for (const k of Object.keys(process.env)) if (/^(CLAUDE_DOOR_|AUDIONOTE_)/.test(k)) delete process.env[k]
  delete process.env.ANTHROPIC_API_KEY
}

test('fill: named values, unknown names kept, spaces in braces', () => {
  assert.equal(fill('A {{page_title}} B', { page_title: 'P' }), 'A P B')
  assert.equal(fill('{{nope}} {{ x }}', { x: 1 }), '{{nope}} 1')
  assert.equal(fill('{{ transcript }}', { transcript: 'x' }), 'x')
})

test('fill: a transcript the template never names is appended; no transcript, nothing appended', () => {
  assert.ok(fill('Summarise.', { transcript: 'words' }).endsWith('Summarise.\n\n<transcript>\nwords\n</transcript>'))
  assert.equal(fill('Plan {{plan}}.', { plan: 'p' }), 'Plan p.')
})

test('door: a bare claude model goes by the CLI without a key, by the API with one; idempotent', () => {
  clean()
  const dir = scratch()
  process.env.CLAUDE_DOOR_KEY_FILE = path.join(dir, 'no-key')
  assert.equal(door('claude-opus-5-5'), 'claude-cli:claude-opus-5-5')
  assert.equal(door(door('claude-opus-5-5')), 'claude-cli:claude-opus-5-5')
  assert.equal(door('ollama:gemma3:4b'), 'ollama:gemma3:4b')
  fs.writeFileSync(path.join(dir, 'key'), 'sk-test\n', { mode: 0o600 })
  process.env.CLAUDE_DOOR_KEY_FILE = path.join(dir, 'key')
  assert.equal(door('claude-opus-5-5'), 'claude-opus-5-5')
  assert.equal(door('claude-cli:claude-opus-5-5'), 'claude-cli:claude-opus-5-5')
  delete process.env.CLAUDE_DOOR_KEY_FILE
  process.env.CLAUDE_DOOR_KEY_FILE = path.join(dir, 'no-key')
  process.env.ANTHROPIC_API_KEY = 'sk-env'
  assert.equal(door('claude-opus-5-5'), 'claude-opus-5-5')
  clean()
})

test('settings: CLAUDE_DOOR_* first, AUDIONOTE_* as the fallback, then the caller default', () => {
  clean()
  assert.equal(defaultModel(), 'claude-opus-5-5')
  assert.equal(defaultModel('claude-opus-5'), 'claude-opus-5')
  process.env.AUDIONOTE_SUMMARY_MODEL = 'ollama:gemma3:4b'
  assert.equal(defaultModel(), 'ollama:gemma3:4b')
  process.env.CLAUDE_DOOR_MODEL = 'claude-fable-5'
  assert.equal(defaultModel(), 'claude-fable-5')
  assert.equal(fallbackModel(), '')
  process.env.AUDIONOTE_FALLBACK_MODEL = 'ollama:gemma3:4b'
  assert.equal(fallbackModel(), 'ollama:gemma3:4b')
  clean()
})

test('isModelId: the Voice Tool rule', () => {
  for (const ok of ['claude-opus-5-5', 'claude-cli:claude-opus-5', 'ollama:qwen3:4b']) assert.ok(isModelId(ok), ok)
  for (const bad of ['gpt-5', 'claude-cli:gpt', '', null, 'claude-opus; rm -rf']) assert.ok(!isModelId(bad), String(bad))
})

test('discover: TXT and spec parsing, a plain URL used as is', async () => {
  assert.deepEqual(discover.txtFields([{ data: 'txtvers=1 model=qwen3:4b proto=https' }]), { txtvers: '1', model: 'qwen3:4b', proto: 'https' })
  assert.deepEqual(discover.txtFields([{ data: '"txtvers=1" "model=qwen3:4b"' }]), { txtvers: '1', model: 'qwen3:4b' })
  assert.equal(discover.parse('dnssd:qwen._ollama._tcp.names.private.fish').name, 'qwen._ollama._tcp.names.private.fish')
  assert.throws(() => discover.parse('dnssd:qwen.names.private.fish'))
  assert.equal(await discover.resolve('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434')
})

// A stand-in claude: prints its arguments, the token it was handed and its stdin.
const fakeClaude = dir => {
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, '#!/bin/sh\necho "ARGS $*"\necho "TOKEN ${CLAUDE_CODE_OAUTH_TOKEN:-none}"\necho "NESTED ${CLAUDECODE:-no}"\ncat\n', { mode: 0o755 })
  return bin
}

test('ask: the CLI road — model, no tools, system prompt, token file, stdin, ms', async () => {
  clean()
  const dir = scratch()
  process.env.CLAUDE_DOOR_KEY_FILE = path.join(dir, 'no-key')
  process.env.CLAUDE_DOOR_BIN = fakeClaude(dir)
  fs.writeFileSync(path.join(dir, 'token'), 'tok-123\n')
  process.env.AUDIONOTE_CLAUDE_TOKEN_FILE = path.join(dir, 'token') // the old name still works
  process.env.CLAUDECODE = '1'
  const out = await ask('claude-opus-5-5', 'the question', { system: 'Be brief.' })
  assert.equal(out.model, 'claude-cli:claude-opus-5-5')
  assert.match(out.markdown, /^ARGS -p --model claude-opus-5-5 --disallowedTools /)
  assert.ok(out.markdown.includes(NO_TOOLS))
  assert.match(out.markdown, /--append-system-prompt Be brief\./)
  assert.match(out.markdown, /TOKEN tok-123/)
  assert.match(out.markdown, /NESTED no/)
  assert.ok(out.markdown.endsWith('the question'))
  assert.equal(typeof out.ms, 'number')
  const tools = await ask('claude-cli:claude-opus-5-5', 'q', { allowTools: true })
  assert.ok(!tools.markdown.includes('--disallowedTools'))
  delete process.env.CLAUDECODE
  clean()
})

test('ask: a CLI that cannot start is unreachable; one that overruns is stopped', async () => {
  clean()
  const dir = scratch()
  process.env.CLAUDE_DOOR_KEY_FILE = path.join(dir, 'no-key')
  process.env.CLAUDE_DOOR_BIN = path.join(dir, 'nowhere')
  await assert.rejects(ask('claude-opus-5-5', 'q'), e => e.unreachable && e.status === 502)
  const slow = path.join(dir, 'slow')
  fs.writeFileSync(slow, '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 })
  process.env.CLAUDE_DOOR_BIN = slow
  await assert.rejects(ask('claude-opus-5-5', 'q', { timeoutMs: 300 }), e => e.status === 504)
  clean()
})

test('scopeArgs: a scope under systemd on Linux by default, a set size always, off never', () => {
  assert.equal(scopeArgs({ platform: 'darwin', underSystemd: false }), null, 'a laptop: no scope')
  assert.equal(scopeArgs({ platform: 'linux', underSystemd: false }), null, 'a shell on the Pi: no scope')
  const auto = scopeArgs({ platform: 'linux', underSystemd: true })
  assert.equal(auto.cap, SCOPE_DEFAULT)
  assert.deepEqual(auto.args, ['--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${SCOPE_DEFAULT}`, '-p', 'MemorySwapMax=0', '--'])
  assert.equal(scopeArgs({ setting: '800M', platform: 'darwin', underSystemd: false }).cap, '800M')
  assert.equal(scopeArgs({ setting: 'off', platform: 'linux', underSystemd: true }), null)
  assert.ok(scopeArgs({ setting: '1G', unit: 'claude-door-1' }).args.includes('--unit=claude-door-1'))
  assert.throws(() => scopeArgs({ setting: 'lots' }), /must be a size/)
})

// A stand-in systemd-run: logs its own words, then execs the command after --.
const fakeRun = dir => {
  const bin = path.join(dir, 'systemd-run')
  fs.writeFileSync(bin, `#!/bin/sh\nwhile [ "$1" != "--" ]; do echo "$1" >> "${dir}/scope.log"; shift; done\nshift\nexec "$@"\n`, { mode: 0o755 })
  return bin
}

test('ask: the CLI road in its own scope — systemd-run carries the cap, the answer is unchanged', async () => {
  clean()
  const dir = scratch()
  process.env.CLAUDE_DOOR_KEY_FILE = path.join(dir, 'no-key')
  process.env.CLAUDE_DOOR_BIN = fakeClaude(dir)
  process.env.CLAUDE_DOOR_SYSTEMD_RUN = fakeRun(dir)
  process.env.CLAUDE_DOOR_SCOPE_MEMORY = '600M'
  const out = await ask('claude-opus-5-5', 'scoped question')
  assert.match(out.markdown, /^ARGS -p --model claude-opus-5-5 /)
  assert.ok(out.markdown.endsWith('scoped question'))
  const log = fs.readFileSync(path.join(dir, 'scope.log'), 'utf8')
  assert.match(log, /--scope/)
  assert.match(log, /MemoryMax=600M/)
  assert.match(log, /MemorySwapMax=0/)
  assert.match(log, /--unit=claude-door-\d+-/)
  process.env.CLAUDE_DOOR_SCOPE_MEMORY = 'off'
  fs.rmSync(path.join(dir, 'scope.log'))
  await ask('claude-opus-5-5', 'q')
  assert.ok(!fs.existsSync(path.join(dir, 'scope.log')), 'off: no systemd-run')
  clean()
})

test('ask: a scope that cannot start, and a CLI killed in its scope, are unreachable with the reason', async () => {
  clean()
  const dir = scratch()
  process.env.CLAUDE_DOOR_KEY_FILE = path.join(dir, 'no-key')
  process.env.CLAUDE_DOOR_BIN = fakeClaude(dir)
  process.env.CLAUDE_DOOR_SCOPE_MEMORY = '600M'
  const noBus = path.join(dir, 'nobus')
  fs.writeFileSync(noBus, '#!/bin/sh\necho "Failed to connect to bus: No medium found" >&2\nexit 1\n', { mode: 0o755 })
  process.env.CLAUDE_DOOR_SYSTEMD_RUN = noBus
  await assert.rejects(ask('claude-opus-5-5', 'q'), e => e.unreachable && e.status === 502 && /own scope: Failed to connect to bus/.test(e.message) && /SCOPE_MEMORY=off/.test(e.message))
  const killed = path.join(dir, 'killed')
  fs.writeFileSync(killed, '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 })
  process.env.CLAUDE_DOOR_SYSTEMD_RUN = killed
  await assert.rejects(ask('claude-opus-5-5', 'q'), e => e.unreachable && /was killed in its own scope \(MemoryMax=600M, no swap\): it went over its memory cap/.test(e.message))
  clean()
})

test('toolArgs: research tools only, offered and approved, the rest disallowed', async () => {
  assert.deepEqual(toolArgs(), ['--disallowedTools', NO_TOOLS])
  assert.deepEqual(toolArgs({ allowTools: true }), [])
  const a = toolArgs({ tools: ['WebSearch', 'WebFetch'] })
  assert.deepEqual(a.slice(0, 4), ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'])
  assert.equal(a[4], '--disallowedTools')
  assert.ok(!a[5].includes('WebSearch') && a[5].includes('Bash') && a[5].includes('Write'))
  assert.throws(() => toolArgs({ tools: ['Bash'] }), /only WebSearch and WebFetch/)
  clean()
  const dir = scratch()
  process.env.CLAUDE_DOOR_KEY_FILE = path.join(dir, 'no-key')
  process.env.CLAUDE_DOOR_BIN = fakeClaude(dir)
  process.env.CLAUDE_DOOR_SCOPE_MEMORY = 'off'
  const out = await ask('claude-opus-5-5', 'q', { tools: ['WebSearch', 'WebFetch'] })
  assert.match(out.markdown, /--tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch --disallowedTools Bash,/)
  await assert.rejects(ask('claude-opus-5-5', 'q', { tools: ['Write'] }), e => e.status === 500)
  clean()
})

test('openai: model ids are accepted (0.2.0)', () => {
  assert.ok(isModelId('openai:llm_auto-big'))
  assert.ok(!isModelId('openai:'))
})
