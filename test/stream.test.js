// askOpenAI streams (0.5.1): a non-streamed answer gets no headers until it is
// written, and Node's fetch gives up after 300 s without headers. These tests
// run against a stand-in SSE server on this machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { askOpenAI, fetchFailure } from '../index.js'

const sse = (chunks, { gapMs = 0, cut = false } = {}) =>
  new Promise(resolve => {
    const seen = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', async () => {
        seen.push(JSON.parse(body || '{}'))
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.flushHeaders()
        for (const c of chunks) {
          if (gapMs) await new Promise(r => setTimeout(r, gapMs))
          res.write(`data: ${JSON.stringify(c)}\n\n`)
        }
        if (cut) return res.socket.destroy()
        res.end('data: [DONE]\n\n')
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }))
  })

const delta = (d, finish = null) => ({ model: 'glm', choices: [{ delta: d, finish_reason: finish }] })

const withUrl = async (url, fn) => {
  process.env.CLAUDE_DOOR_OPENAI_URL = url
  try {
    return await fn()
  } finally {
    delete process.env.CLAUDE_DOOR_OPENAI_URL
  }
}

test('askOpenAI asks for a stream and joins the content deltas; reasoning stays out', async () => {
  const s = await sse([
    delta({ role: 'assistant' }),
    delta({ reasoning: 'thinking about it…' }),
    delta({ content: '# Plan\n' }),
    delta({ content: 'redrafted' }, 'stop'),
    { model: 'glm', choices: [], usage: { prompt_tokens: 22000, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 600 } } },
  ])
  try {
    const got = await withUrl(s.url, () => askOpenAI('openai:llm_auto-big', 'q', { maxTokens: 32000 }))
    assert.equal(s.seen[0].stream, true)
    assert.deepEqual(s.seen[0].stream_options, { include_usage: true })
    assert.equal(s.seen[0].max_tokens, 32000)
    assert.equal(got.markdown, '# Plan\nredrafted')
    assert.equal(got.model, 'openai:glm')
    assert.equal(got.stop, 'stop')
    assert.deepEqual(got.usage, { input: 22000, output: 900, reasoning: 600 })
  } finally {
    s.close()
  }
})

test('a slow stream is read to the end: headers come first, then a chunk at a time', async () => {
  const s = await sse([delta({ content: 'a' }), delta({ content: 'b' }), delta({ content: 'c' }, 'stop')], { gapMs: 400 })
  try {
    const got = await withUrl(s.url, () => askOpenAI('openai:m', 'q'))
    assert.equal(got.markdown, 'abc')
  } finally {
    s.close()
  }
})

test('a streamed answer cut by length is a failure, not a short plan', async () => {
  const s = await sse([delta({ content: 'half a pl' }, 'length')])
  try {
    await withUrl(s.url, () => assert.rejects(askOpenAI('openai:m', 'q'), /ran out of room/))
  } finally {
    s.close()
  }
})

test('a stream that dies partway says how long it ran and why', async () => {
  const s = await sse([delta({ content: 'part' })], { cut: true })
  try {
    await withUrl(s.url, () => assert.rejects(askOpenAI('openai:m', 'q'), e => e.unreachable && /stopped after \d+s/.test(e.message)))
  } finally {
    s.close()
  }
})

test('an error chunk in the stream is reported as the server said it', async () => {
  const s = await sse([{ error: { message: 'model crashed' } }])
  try {
    await withUrl(s.url, () => assert.rejects(askOpenAI('openai:m', 'q'), /stream reported an error: model crashed/))
  } finally {
    s.close()
  }
})

test('fetchFailure names undici\'s cause: "fetch failed" alone hid a 300 s header timeout', async () => {
  const e = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) })
  assert.equal(fetchFailure(e), 'fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)')
  const closed = await new Promise(r => { const sv = http.createServer().listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)) }) })
  await withUrl(`http://127.0.0.1:${closed}`, () => assert.rejects(askOpenAI('openai:m', 'q'), /could not be reached: fetch failed \(ECONNREFUSED/))
})

test('reasoning_effort: low by default, CLAUDE_DOOR_REASONING_EFFORT changes it, off sends none', async () => {
  const s = await sse([delta({ content: 'ok' }, 'stop')])
  const s2 = await sse([delta({ content: 'ok' }, 'stop')])
  const s3 = await sse([delta({ content: 'ok' }, 'stop')])
  try {
    await withUrl(s.url, () => askOpenAI('openai:m', 'q'))
    assert.equal(s.seen[0].reasoning_effort, 'low')
    process.env.CLAUDE_DOOR_REASONING_EFFORT = 'medium'
    await withUrl(s2.url, () => askOpenAI('openai:m', 'q'))
    assert.equal(s2.seen[0].reasoning_effort, 'medium')
    process.env.CLAUDE_DOOR_REASONING_EFFORT = 'off'
    await withUrl(s3.url, () => askOpenAI('openai:m', 'q'))
    assert.equal('reasoning_effort' in s3.seen[0], false)
    await withUrl(s3.url, () => askOpenAI('openai:m', 'q', { effort: 'high' }))
    assert.equal(s3.seen[1].reasoning_effort, 'high')
  } finally {
    delete process.env.CLAUDE_DOOR_REASONING_EFFORT
    s.close(); s2.close(); s3.close()
  }
})

test('a budget spent wholly on reasoning says so, with the effort it was asked at', async () => {
  const s = await sse([
    delta({ reasoning: 'x'.repeat(500) }),
    delta({ reasoning: 'y'.repeat(500) }, 'length'),
    { model: 'glm', choices: [], usage: { prompt_tokens: 22000, completion_tokens: 32000, completion_tokens_details: { reasoning_tokens: 32000 } } },
  ])
  try {
    await withUrl(s.url, () =>
      assert.rejects(askOpenAI('openai:llm_auto-big', 'q', { maxTokens: 32000 }), e =>
        e.unreachable && /spent all 32000 max_tokens reasoning \(32000 reasoning tokens, reasoning_effort low\) and wrote no answer/.test(e.message)))
  } finally {
    s.close()
  }
})
