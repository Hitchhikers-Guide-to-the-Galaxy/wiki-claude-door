// autoModel: a tier and a question's size to a model the door can reach.
// 0.4.0 (David, 20 Oct 2026): big runs to Claude (Fable), small runs to the coop's own router.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoModel, shortModel, tokensLabel, AUTO_LIGHT, AUTO_BIG } from '../index.js'

// listModels as the laptop saw it on 20 Oct 2026: GLM-5.3 Flash loaded behind llm_auto-big
const doors = ({ loaded = 'openai:llm_glm-5.3-flash-pp', coopError = '', routerWindow = 262144 } = {}) => [
  {
    door: 'openai',
    ...(coopError ? { error: coopError } : {}),
    models: coopError
      ? []
      : [
          { id: 'openai:llm_auto-big', selector: true, routesTo: loaded, contextLength: routerWindow, loaded: true },
          { id: 'openai:llm_bonsai-27b-binary', contextLength: 32768, loaded: false },
          { id: 'openai:llm_dsv4-vision', contextLength: 384000, loaded: false },
          { id: 'openai:llm_dsv4s-pp-optimized', contextLength: 384000, loaded: false },
          { id: 'openai:llm_glm-5.3-flash-pp', contextLength: 262144, loaded: false },
        ].map(m => (m.id === loaded ? { ...m, loaded: true } : m)),
  },
  { door: 'claude', models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(id => ({ id, contextLength: 200000, tools: true })) },
  { door: 'ollama', models: [{ id: 'ollama:qwen3:4b', contextLength: 32768 }] },
]

test('the defaults: the coop router for light, Claude Fable 5.1 for big', () => {
  assert.equal(AUTO_LIGHT, 'openai:llm_auto-big')
  assert.equal(AUTO_BIG, 'claude-fable-5-1')
})

test('light: the coop router, saying where it routes now; never Ollama', () => {
  const r = autoModel({ tier: 'light', need: 34000, doors: doors() })
  assert.equal(r.model, 'openai:llm_auto-big')
  assert.equal(r.tier, 'light')
  assert.equal(r.note, 'routes to glm-5.3-flash-pp')
})

test('light: a router too small for it hands over to the roomiest coop model', () => {
  const r = autoModel({ tier: 'light', need: 40000, doors: doors({ routerWindow: 32768 }) })
  assert.equal(r.model, 'openai:llm_dsv4s-pp-optimized')
  assert.match(r.note, /auto-big cannot hold it; cold/)
})

test('light: the coop down, Claude with the reason', () => {
  const r = autoModel({ tier: 'light', need: 30000, doors: doors({ coopError: 'fetch failed' }) })
  assert.equal(r.model, 'claude-fable-5-1')
  assert.equal(r.tier, 'big')
  assert.equal(r.asked, 'light')
  assert.match(r.note, /coop did not answer \(fetch failed\)/)
})

test('big: Claude Fable 5.1; another Claude model when named', () => {
  const r = autoModel({ tier: 'big', need: 60000, doors: doors() })
  assert.equal(r.model, 'claude-fable-5-1')
  assert.equal(r.tier, 'big')
  assert.equal(r.note, '')
  assert.equal(autoModel({ tier: 'big', need: 60000, doors: doors(), big: 'claude-opus-5-5' }).model, 'claude-opus-5-5')
  assert.equal(autoModel({ tier: 'careful', need: 60000, doors: doors() }).model, 'claude-fable-5-1') // 0.3.0 callers
})

test("big: over Claude's window, the roomiest coop model, and why", () => {
  const r = autoModel({ tier: 'big', need: 300000, doors: doors() })
  assert.equal(r.model, 'openai:llm_dsv4s-pp-optimized')
  assert.match(r.note, /too big for Claude's window; cold/)
})

test('too big for every window: no model, and why', () => {
  assert.match(autoModel({ tier: 'big', need: 500000, doors: doors() }).note, /every coop model/)
  const r = autoModel({ tier: 'light', need: 500000, doors: doors() })
  assert.equal(r.model, '')
  assert.match(r.note, /no coop model holds it, and it is too big for Claude/)
})

test('an unknown tier is a 400', () => {
  assert.throws(() => autoModel({ tier: 'huge', doors: doors() }), e => e.status === 400)
})

test('shortModel and tokensLabel', () => {
  assert.equal(shortModel('openai:llm_glm-5.3-flash-pp'), 'glm-5.3-flash-pp')
  assert.equal(shortModel('openai:llm_auto-big'), 'auto-big')
  assert.equal(shortModel('claude-cli:claude-fable-5-1'), 'claude-fable-5-1')
  assert.equal(tokensLabel(34210), '34k')
  assert.equal(tokensLabel(800), '800')
})
