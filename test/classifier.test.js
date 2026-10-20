// classifyTier (0.5.0): a summary of the run on a loaded coop model, light or
// big before the real call; the rule stands whenever it does not decide.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTier, classifierModel, parseTier, CLASSIFIER_SYSTEM } from '../index.js'

const doors = ({ loaded = ['openai:llm_glm-5.3-flash-pp'], coopError = '' } = {}) => [
  {
    door: 'openai',
    ...(coopError ? { error: coopError } : {}),
    models: coopError
      ? []
      : [
          { id: 'openai:llm_auto-big', selector: true, routesTo: 'openai:llm_glm-5.3-flash-pp', contextLength: 262144, loaded: true },
          { id: 'openai:llm_glm-5.3-flash-pp', contextLength: 262144, reasoning: true },
          { id: 'openai:llm_dsv4-vision', contextLength: 384000 },
          { id: 'openai:llm_qwen3.8-27b-uncensored', contextLength: 32768 },
        ].map(m => (loaded.includes(m.id) ? { ...m, loaded: true } : { ...m, loaded: m.loaded === true })),
  },
  { door: 'claude', models: [{ id: 'claude-fable-5-1', contextLength: 200000 }] },
]
const answer = (markdown, usage = { input: 300, output: 520, reasoning: 500 }) => async (model, content, opts) => ({ markdown, model: model.replace(/^openai:llm_/, 'openai:'), usage, system: opts.system, content })

test('parseTier reads the one line, past thinking and markdown', () => {
  assert.deepEqual(parseTier('big: five answers and a whole site'), { tier: 'big', reason: 'five answers and a whole site', raw: 'big: five answers and a whole site' })
  assert.equal(parseTier('<think>hmm</think>\n**Light** — a short plan, two answers').tier, 'light')
  assert.equal(parseTier('<think>hmm</think>\n**Light** — a short plan, two answers').reason, 'a short plan, two answers')
  assert.equal(parseTier('LIGHT').tier, 'light')
  assert.equal(parseTier('Bigger than most').tier, null)
  assert.equal(parseTier('I think this is a light run').tier, null)
  assert.equal(parseTier('').tier, null)
})

test('classifierModel: the router\'s loaded target, else any loaded text model, never cold, never vision', () => {
  assert.equal(classifierModel(doors()).id, 'openai:llm_glm-5.3-flash-pp')
  assert.equal(classifierModel(doors({ loaded: ['openai:llm_qwen3.8-27b-uncensored'] })).id, 'openai:llm_qwen3.8-27b-uncensored')
  assert.equal(classifierModel(doors({ loaded: ['openai:llm_dsv4-vision'] })), null)
  assert.equal(classifierModel(doors({ loaded: [] })), null)
  assert.equal(classifierModel(doors(), 'off'), null)
  assert.equal(classifierModel(doors(), 'glm-5.3-flash-pp').id, 'openai:llm_glm-5.3-flash-pp') // named short
  assert.equal(classifierModel(doors(), 'openai:llm_qwen3.8-27b-uncensored'), null) // named but cold
})

test('a loaded coop model reads the summary and decides, with the rubric as system prompt', async () => {
  const r = await classifyTier({ summary: 'Revise Plan of Toy Plan: 9k tokens, 2 answers', doors: doors(), asker: answer('light: a short plan with two answers') })
  assert.equal(r.tier, 'light')
  assert.equal(r.reason, 'a short plan with two answers')
  assert.equal(r.model, 'openai:glm-5.3-flash-pp')
  assert.equal(r.usage.reasoning, 500)
  assert.ok(r.ms >= 0)
  const seen = await answer('big: x')('openai:llm_glm-5.3-flash-pp', 'c', { system: CLASSIFIER_SYSTEM })
  assert.match(seen.system, /light: reason/)
})

test('it does not decide: no model loaded, the coop down, off, an empty summary, a call that fails, an answer that is neither word', async () => {
  const none = await classifyTier({ summary: 's', doors: doors({ loaded: [] }), asker: answer('big: x') })
  assert.equal(none.tier, null)
  assert.match(none.skipped, /no coop model is loaded/)
  const down = await classifyTier({ summary: 's', doors: doors({ coopError: 'fetch failed' }), asker: answer('big: x') })
  assert.match(down.skipped, /coop did not answer \(fetch failed\)/)
  const was = process.env.CLAUDE_DOOR_CLASSIFIER
  process.env.CLAUDE_DOOR_CLASSIFIER = 'off'
  const off = await classifyTier({ summary: 's', doors: doors(), asker: answer('big: x') })
  assert.match(off.skipped, /off/)
  if (was === undefined) delete process.env.CLAUDE_DOOR_CLASSIFIER
  else process.env.CLAUDE_DOOR_CLASSIFIER = was
  const empty = await classifyTier({ summary: '  ', doors: doors(), asker: answer('big: x') })
  assert.match(empty.skipped, /no summary/)
  const failed = await classifyTier({ summary: 's', doors: doors(), asker: async () => { throw new Error('timed out') } })
  assert.equal(failed.tier, null)
  assert.match(failed.skipped, /failed: timed out/)
  assert.equal(failed.model, 'openai:llm_glm-5.3-flash-pp')
  const odd = await classifyTier({ summary: 's', doors: doors(), asker: answer('Medium, I would say.') })
  assert.equal(odd.tier, null)
  assert.match(odd.skipped, /neither light nor big: Medium/)
})

test('a named classifier model is used when loaded, and skipped with its name when cold', async () => {
  const named = await classifyTier({ summary: 's', doors: doors({ loaded: ['openai:llm_qwen3.8-27b-uncensored', 'openai:llm_glm-5.3-flash-pp'] }), model: 'qwen3.8-27b-uncensored', asker: answer('big: many answers') })
  assert.equal(named.model, 'openai:qwen3.8-27b-uncensored')
  const cold = await classifyTier({ summary: 's', doors: doors(), model: 'qwen3.8-27b-uncensored', asker: answer('big: x') })
  assert.match(cold.skipped, /qwen3.8-27b-uncensored is not loaded/)
})
