/**
 * The edges that decide whether this adapter is safe to leave running:
 * deadlines, image degradation, environment-backed keys, and a corrupt settings
 * document.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAihubAdapter, DEFAULT_TIMEOUTS } from '../../src/host/adapter.mjs'
import { parseState } from '../../src/host/state.mjs'
import {
  abortError,
  collect,
  frameOf,
  hangingFetch,
  jsonResponse,
  modelFixture,
  recordingFetch,
  recordingLogger,
  scriptedResponse,
  sseResponse,
  soleFinish,
  stateWith,
  supplierFixture,
  withGlobalFetch,
} from './support/helpers.mjs'

const USER_TURN = { role: 'user', content: [{ type: 'text', text: '你好' }] }
const IMAGE_TURN = {
  role: 'user',
  content: [
    { type: 'text', text: '看图' },
    { type: 'image', attachment: { attachmentId: 'sha256:abc', variantId: 'v1', mediaType: 'image/png', width: 640, height: 480, name: 'shot.png' } },
  ],
}
const TEXT_ANSWER = [{ choices: [{ delta: { content: '好' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, 'DONE']

function adapterFor(models, options = {}) {
  const logger = recordingLogger()
  const adapter = createAihubAdapter({
    route: 'aihub',
    readState: options.readState ?? (() => stateWith(models)),
    attachments: options.attachments,
    logger,
    timeouts: options.timeouts,
  })
  return { adapter, logger }
}

function callOptions(overrides = {}) {
  return { provider: 'aihub', model: 'm_1', messages: [USER_TURN], maxTokens: 64, ...overrides }
}

test('the documented deadlines are the defaults', () => {
  assert.deepEqual(DEFAULT_TIMEOUTS, { firstResponseMs: 30_000, idleMs: 120_000 })
})

test('a supplier that never answers is cut at the first-response deadline', async () => {
  const { adapter, logger } = adapterFor([modelFixture()], { timeouts: { firstResponseMs: 20, idleMs: 5000 } })
  const started = Date.now()
  const chunks = await withGlobalFetch(hangingFetch(), () => collect(adapter.stream(callOptions())))
  const elapsed = Date.now() - started
  const finish = soleFinish(chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TIMEOUT')
  assert.match(finish.reason.failure.message, /首响应超时/)
  assert.ok(elapsed < 2000, `the attempt should end promptly, took ${elapsed}ms`)
  assert.match(logger.warnings[0], /TIMEOUT/)
})

test('a stream that goes quiet is cut at the idle deadline and keeps what arrived', async () => {
  const { adapter } = adapterFor([modelFixture()], { timeouts: { firstResponseMs: 5000, idleMs: 20 } })
  const stall = (url, init) => scriptedResponse([
    frameOf({ choices: [{ delta: { content: '前半句' } }] }),
    (signal) => new Promise((resolve, reject) => {
      if (signal === undefined) return
      if (signal.aborted === true) {
        reject(abortError())
        return
      }
      signal.addEventListener('abort', () => reject(abortError()), { once: true })
    }),
  ], { signal: init.signal })
  const chunks = await withGlobalFetch(stall, () => collect(adapter.stream(callOptions())))
  const finish = soleFinish(chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TIMEOUT')
  assert.match(finish.reason.failure.message, /空闲超过 20ms/)
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), '前半句')
})

test('a text-only model sends a placeholder instead of bytes and warns once', async () => {
  const requests = []
  const { adapter, logger } = adapterFor([modelFixture({ vision: false })], {
    attachments: () => ({
      readImageRequest: async () => {
        requests.push('called')
        return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }
      },
    }),
  })
  const fetchDouble = recordingFetch(sseResponse(TEXT_ANSWER))
  await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions({ messages: [IMAGE_TURN] }))))
  assert.deepEqual(requests, [], 'a text-only model must not read attachment bytes')
  const body = JSON.parse(fetchDouble.requests[0].init.body)
  assert.equal(typeof body.messages[0].content, 'string')
  assert.match(body.messages[0].content, /\[image not sent: shot\.png, image\/png, 640x480\]/)
  assert.deepEqual(logger.warnings.filter((warning) => warning.includes('没有开启视觉')).length, 1)
})

test('a vision model inlines real bytes as a data URL with the storage target', async () => {
  const calls = []
  const { adapter } = adapterFor([modelFixture({ vision: true })], {
    attachments: () => ({
      readImageRequest: async (ref, target, signal) => {
        calls.push({ ref, target, signalType: typeof signal })
        return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 640, height: 480 }
      },
    }),
  })
  const fetchDouble = recordingFetch(sseResponse(TEXT_ANSWER))
  await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions({ messages: [IMAGE_TURN] }))))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].target, { width: 640, height: 480, maxBytes: 5 * 1024 * 1024 })
  assert.equal(calls[0].ref.attachmentId, 'sha256:abc')
  const body = JSON.parse(fetchDouble.requests[0].init.body)
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
  ])
})

test('a failing attachment read degrades to text and the turn still succeeds', async () => {
  const { adapter, logger } = adapterFor([modelFixture({ vision: true })], {
    attachments: () => ({
      readImageRequest: async () => {
        throw new Error('attachment store is unavailable')
      },
    }),
  })
  const fetchDouble = recordingFetch(sseResponse(TEXT_ANSWER))
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions({ messages: [IMAGE_TURN] }))))
  assert.equal(soleFinish(chunks).reason.kind, 'stop')
  const body = JSON.parse(fetchDouble.requests[0].init.body)
  assert.match(body.messages[0].content, /\[image not sent/)
  assert.equal(logger.warnings.filter((warning) => warning.includes('图片读取失败')).length, 1)
})

test('a vision model without an attachment store still sends the conversation', async () => {
  const { adapter, logger } = adapterFor([modelFixture({ vision: true })])
  const fetchDouble = recordingFetch(sseResponse(TEXT_ANSWER))
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions({ messages: [IMAGE_TURN] }))))
  assert.equal(soleFinish(chunks).reason.kind, 'stop')
  assert.match(JSON.parse(fetchDouble.requests[0].init.body).messages[0].content, /\[image not sent/)
  assert.equal(logger.warnings.filter((warning) => warning.includes('附件服务')).length, 1)
})

test('an image in recorded assistant history is text for Anthropic, never a block', async () => {
  const supplier = supplierFixture({ api: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1', model: 'claude-test' })
  const { adapter } = adapterFor([modelFixture({ vision: true, suppliers: [supplier] })], {
    attachments: () => ({ readImageRequest: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }) }),
  })
  const answer = [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '开始' }] },
    { role: 'assistant', content: [
      { type: 'text', text: '我看到了' },
      { type: 'image', attachment: { attachmentId: 'sha256:old', variantId: 'v1', mediaType: 'image/png', width: 10, height: 10 } },
    ] },
  ]
  const fetchDouble = recordingFetch(sseResponse(answer))
  await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions({ messages }))))
  const body = JSON.parse(fetchDouble.requests[0].init.body)
  const assistant = body.messages[1]
  assert.equal(assistant.role, 'assistant')
  assert.ok(assistant.content.every((block) => block.type === 'text'), JSON.stringify(assistant.content))
})

test('an env-backed key is resolved per request and never logged', async () => {
  const supplier = supplierFixture({ apiKey: 'env:AIHUB_TEST_KEY' })
  const previous = process.env.AIHUB_TEST_KEY
  process.env.AIHUB_TEST_KEY = 'sk-from-environment'
  try {
    const { adapter } = adapterFor([modelFixture({ suppliers: [supplier] })])
    const fetchDouble = recordingFetch(sseResponse(TEXT_ANSWER))
    await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
    assert.equal(fetchDouble.requests[0].init.headers.authorization, 'Bearer sk-from-environment')
  } finally {
    if (previous === undefined) delete process.env.AIHUB_TEST_KEY
    else process.env.AIHUB_TEST_KEY = previous
  }
})

test('a missing env-backed key is reported by variable name, without a value', async () => {
  const supplier = supplierFixture({ apiKey: 'env:AIHUB_ABSENT_KEY' })
  delete process.env.AIHUB_ABSENT_KEY
  const { adapter, logger } = adapterFor([modelFixture({ suppliers: [supplier] })])
  const fetchDouble = recordingFetch(sseResponse(TEXT_ANSWER))
  await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(fetchDouble.requests[0].init.headers.authorization, undefined)
  assert.equal(logger.warnings.length, 1)
  assert.match(logger.warnings[0], /AIHUB_ABSENT_KEY/)
})

test('a provider that echoes the key in its error body is scrubbed before logging', async () => {
  const supplier = supplierFixture({ apiKey: 'sk-echoed-secret-value' })
  const { adapter, logger } = adapterFor([modelFixture({ suppliers: [supplier] })])
  const fetchDouble = recordingFetch(
    jsonResponse(401, { error: { message: 'Incorrect API key provided: sk-echoed-secret-value' } }),
  )
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  const { failure } = soleFinish(chunks).reason
  assert.ok(!failure.message.includes('sk-echoed-secret-value'), failure.message)
  assert.match(failure.message, /\[redacted\]/)
  assert.ok(!logger.warnings.join(' ').includes('sk-echoed-secret-value'))
})

test('a corrupt document yields an empty catalog and a clean terminal chunk', async () => {
  for (const readState of [() => parseState('{"version":1,'), () => ({}), () => undefined, () => ({ models: 'nope' })]) {
    const { adapter } = adapterFor([], { readState })
    assert.deepEqual(await adapter.listModels('aihub'), [])
    const chunks = await withGlobalFetch(hangingFetch(), () => collect(adapter.stream(callOptions())))
    const finish = soleFinish(chunks)
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'INVALID_CONFIG')
  }
})

test('the default fetch is used when the host does not inject one', async () => {
  const { adapter } = adapterFor([modelFixture()])
  let seen
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen = url
    return sseResponse(TEXT_ANSWER)
  }
  try {
    await collect(adapter.stream(callOptions()))
  } finally {
    globalThis.fetch = original
  }
  assert.equal(seen, 'https://upstream.example/v1/chat/completions')
})
