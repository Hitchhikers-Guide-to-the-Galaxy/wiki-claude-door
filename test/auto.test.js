// autoModel (0.3.0): a tier and a question's size to a model the door can reach.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoModel, shortModel, tokensLabel } from '../index.js'

// listModels as the laptop saw it on 20 Oct 2026: GLM-5.3 Flash loaded behind llm_auto-big
const doors = ({ loaded = 'openai:llm_glm-5.3-flash-pp', coopError = '' } = {}) => [
  {
    door: 'openai',
    ...(coopError ? { error: coopError } : {}),
    models: coopError
      ? []
      : [
          { id: 'openai:llm_auto-big', selector: true, routesTo: loaded, contextLength: 262144, loaded: true },
          { id: 'openai:llm_bonsai-27b-binary', contextLength: 32768, loaded: false },
          { id: 'openai:llm_dsv4-vision', contextLength: 384000, loaded: false },
          { id: 'openai:llm_dsv4s-pp-optimized', contextLength: 384000, loaded: false },
          { id: 'openai:llm_glm-5.3-flash-pp', contextLength: 262144, loaded: false },
          { id: 'openai:llm_qwen3.8-27b-uncensored', contextLength: 32768, loaded: false },
        ].map(m => (m.id === loaded ? { ...m, loaded: true } : m)),
  },
  { door: 'claude', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(id => ({ id, contextLength: 200000, tools: true })) },
  { door: 'ollama', models: [{ id: 'ollama:qwen3:4b', contextLength: 32768 }] },
]

test('light: the loaded coop model, never the selector, never Ollama', () => {
  const r = autoModel({ tier: 'light', need: 34000, doors: doors() })
  assert.equal(r.model, 'openai:llm_glm-5.3-flash-pp')
  assert.equal(r.tier, 'light')
  assert.equal(r.loaded, true)
  assert.equal(r.note, '')
})

test('light: a small loaded model that cannot hold it goes big, cold, and says so', () => {
  const r = autoModel({ tier: 'light', need: 40000, doors: doors({ loaded: 'openai:llm_qwen3.8-27b-uncensored' }) })
  assert.equal(r.model, 'openai:llm_dsv4s-pp-optimized') // largest window, the non-vision one among equals
  assert.equal(r.tier, 'big')
  assert.match(r.note, /loaded coop model cannot hold it; cold/)
})

test('big: a loaded big-window model first, so the coop does not swap; else the largest window; a named one wins', () => {
  const warm = autoModel({ tier: 'big', need: 60000, doors: doors() })
  assert.equal(warm.model, 'openai:llm_glm-5.3-flash-pp')
  assert.equal(warm.tier, 'big')
  assert.equal(warm.note, '')
  // the loaded model cannot hold it: the largest window, cold
  assert.equal(autoModel({ tier: 'big', need: 300000, doors: doors() }).model, 'openai:llm_dsv4s-pp-optimized')
  // the loaded model is small: the largest window, cold
  assert.equal(autoModel({ tier: 'big', need: 20000, doors: doors({ loaded: 'openai:llm_qwen3.8-27b-uncensored' }) }).model, 'openai:llm_dsv4s-pp-optimized')
  const named = autoModel({ tier: 'big', need: 60000, doors: doors(), big: 'openai:llm_dsv4s-pp-optimized' })
  assert.equal(named.model, 'openai:llm_dsv4s-pp-optimized')
  assert.match(named.note, /cold/)
  // named but too small: the rule goes on
  assert.equal(autoModel({ tier: 'big', need: 60000, doors: doors(), big: 'openai:llm_bonsai-27b-binary' }).model, 'openai:llm_glm-5.3-flash-pp')
})

test('careful: Claude; over Claude\'s window, the biggest coop model', () => {
  const r = autoModel({ tier: 'careful', need: 50000, doors: doors() })
  assert.equal(r.model, 'claude-opus-5-5')
  assert.equal(autoModel({ tier: 'careful', need: 50000, doors: doors(), careful: 'claude-sonnet-5-5' }).model, 'claude-sonnet-5-5')
  const huge = autoModel({ tier: 'careful', need: 300000, doors: doors() })
  assert.equal(huge.model, 'openai:llm_dsv4s-pp-optimized')
  assert.match(huge.note, /too big for Claude/)
})

test('the coop down: Claude, with the reason', () => {
  const r = autoModel({ tier: 'light', need: 30000, doors: doors({ coopError: 'fetch failed' }) })
  assert.equal(r.model, 'claude-opus-5-5')
  assert.equal(r.tier, 'careful')
  assert.equal(r.asked, 'light')
  assert.match(r.note, /coop did not answer \(fetch failed\)/)
})

test('too big for every window: no model, and why', () => {
  const r = autoModel({ tier: 'big', need: 500000, doors: doors() })
  assert.equal(r.model, '')
  assert.match(r.note, /no coop model holds it, and it is too big for Claude/)
})

test('an unknown tier is a 400', () => {
  assert.throws(() => autoModel({ tier: 'huge', doors: doors() }), e => e.status === 400)
})

test('shortModel and tokensLabel', () => {
  assert.equal(shortModel('openai:llm_glm-5.3-flash-pp'), 'glm-5.3-flash-pp')
  assert.equal(shortModel('claude-cli:claude-opus-5-5'), 'claude-opus-5-5')
  assert.equal(tokensLabel(34210), '34k')
  assert.equal(tokensLabel(800), '800')
})
