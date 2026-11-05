/**
 * Failover: the behaviour the whole plugin exists for.
 *
 * Three decisions are pinned here — fail over only before the first chunk,
 * stop once content has been delivered, and aggregate when the chain is
 * exhausted — plus the rule that no diagnostic may contain a credential.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAihubAdapter } from '../../src/host/adapter.mjs'
import {
  abortError,
  collect,
  frameOf,
  jsonResponse,
  modelFixture,
  recordingFetch,
  recordingLogger,
  scriptedResponse,
  sseResponse,
  soleFinish,
  stateWith,
  supplierFixture,
  textOf,
  withGlobalFetch,
} from './support/helpers.mjs'

const USER_TURN = { role: 'user', content: [{ type: 'text', text: '你好' }] }
/** A fresh successful response per use: a response body can only be read once. */
function success() {
  return sseResponse([
    { choices: [{ delta: { content: '来自备用线路' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    'DONE',
  ])
}

function chain(options = {}) {
  const primary = supplierFixture({
    id: 's_a',
    label: '主线路',
    baseURL: 'https://a.example/v1',
    model: 'gpt-primary',
    apiKey: 'sk-primary-secret',
  })
  const backup = supplierFixture({
    id: 's_b',
    label: '备用线路',
    baseURL: 'https://b.example/v1',
    model: 'gpt-backup',
    apiKey: 'sk-backup-secret',
  })
  const logger = recordingLogger()
  const adapter = createAihubAdapter({
    route: 'aihub',
    readState: () => stateWith([modelFixture({ ...options.model, suppliers: [primary, backup] })]),
    logger,
    timeouts: options.timeouts,
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
  })
  return { adapter, logger, primary, backup }
}

function callOptions(overrides = {}) {
  return { provider: 'aihub', model: 'm_1', messages: [USER_TURN], ...overrides }
}

test('a 401 before any content fails over to the next supplier', async () => {
  const { adapter, logger } = chain()
  const fetchDouble = recordingFetch(jsonResponse(401, { error: { message: 'invalid api key' } }), success())
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(soleFinish(chunks).reason.kind, 'stop')
  assert.equal(textOf(chunks), '来自备用线路')
  assert.equal(fetchDouble.requests.length, 2)
  assert.equal(fetchDouble.requests[0].url, 'https://a.example/v1/chat/completions')
  assert.equal(fetchDouble.requests[1].url, 'https://b.example/v1/chat/completions')
  assert.equal(JSON.parse(fetchDouble.requests[1].init.body).model, 'gpt-backup')
  assert.equal(chunks[0].index, 0, 'the second attempt starts a fresh block index')
})

test('the failover warning names label, model and reason, and never the key', async () => {
  const { adapter, logger } = chain()
  const fetchDouble = recordingFetch(jsonResponse(401, { error: { message: 'invalid api key' } }), success())
  await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(logger.warnings.length, 1)
  const [warning] = logger.warnings
  assert.match(warning, /主线路/)
  assert.match(warning, /gpt-primary/)
  assert.match(warning, /AUTH/)
  assert.match(warning, /切换到/)
  assert.match(warning, /备用线路/)
  assert.ok(!warning.includes('sk-primary-secret'), 'a key must never reach a log line')
  assert.ok(!logger.warnings.join(' ').includes('sk-backup-secret'))
})

test('an error event inside the first SSE stream also fails over', async () => {
  const { adapter } = chain()
  const inBandError = sseResponse([{ error: { message: 'bad key', type: 'invalid_api_key' } }])
  const fetchDouble = recordingFetch(inBandError, success())
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(soleFinish(chunks).reason.kind, 'stop')
  assert.equal(fetchDouble.requests.length, 2)
})

test('a connection error fails over', async () => {
  const { adapter, logger } = chain()
  const fetchDouble = recordingFetch(() => {
    throw Object.assign(new Error('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND a.example') })
  }, success())
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(soleFinish(chunks).reason.kind, 'stop')
  assert.equal(fetchDouble.requests.length, 2)
  assert.match(logger.warnings[0], /TRANSPORT/)
  assert.match(logger.warnings[0], /getaddrinfo ENOTFOUND/)
})

test('a break after partial content ends the turn instead of restarting it', async () => {
  const { adapter, logger } = chain()
  // One text delta, then the stream closes without a finish reason or [DONE].
  const truncated = sseResponse([{ choices: [{ delta: { content: '已经说了半句' } }] }], { split: false })
  const fetchDouble = recordingFetch(truncated, success())
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  const finish = soleFinish(chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'STREAM_CLOSED')
  assert.equal(textOf(chunks), '已经说了半句', 'the partial answer is kept as-is')
  assert.equal(fetchDouble.requests.length, 1, 'the backup supplier is never tried')
  assert.match(logger.warnings[0], /无法切换/)
})

test('when every supplier fails the finish aggregates the whole chain', async () => {
  const { adapter, logger } = chain()
  const fetchDouble = recordingFetch(
    jsonResponse(401, { error: { message: 'invalid api key' } }),
    jsonResponse(503, { error: { message: 'upstream overloaded' } }, { 'retry-after': '2' }),
  )
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  const finish = soleFinish(chunks)
  assert.equal(finish.reason.kind, 'error')
  const failure = finish.reason.failure
  assert.match(failure.message, /所有 2 个供应方都失败了/)
  assert.match(failure.message, /主线路/)
  assert.match(failure.message, /备用线路/)
  assert.match(failure.message, /AUTH/)
  assert.match(failure.message, /SERVER/)
  assert.equal(failure.code, 'SERVER', 'the last blocker owns the code')
  assert.equal(failure.status, 503)
  assert.equal(failure.providerRetryAfterMs, 2000)
  assert.equal(fetchDouble.requests.length, 2)
  assert.equal(logger.warnings.length, 2)
})

test('a long chain collapses its middle in the failure message', async () => {
  const suppliers = Array.from({ length: 6 }, (_, index) => supplierFixture({
    id: `s_${index}`,
    label: `线路${index + 1}`,
    baseURL: `https://line${index}.example/v1`,
  }))
  const logger = recordingLogger()
  const adapter = createAihubAdapter({
    route: 'aihub',
    readState: () => stateWith([modelFixture({ suppliers })]),
    logger,
  })
  const responses = suppliers.map(() => jsonResponse(500, { error: { message: 'boom' } }))
  const fetchDouble = recordingFetch(...responses)
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  const { message } = soleFinish(chunks).reason.failure
  assert.match(message, /线路1/)
  assert.match(message, /线路6/)
  assert.match(message, /另有 2 个供应方失败/)
  assert.equal(fetchDouble.requests.length, 6)
})

test('a disabled supplier is skipped without being called', async () => {
  const disabled = supplierFixture({ id: 's_off', label: '停用线路', baseURL: 'https://off.example/v1', enabled: false })
  const live = supplierFixture({ id: 's_on', label: '在用线路', baseURL: 'https://on.example/v1' })
  const logger = recordingLogger()
  const adapter = createAihubAdapter({ route: 'aihub', readState: () => stateWith([modelFixture({ suppliers: [disabled, live] })]), logger })
  const fetchDouble = recordingFetch(success())
  await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(fetchDouble.requests.length, 1)
  assert.equal(fetchDouble.requests[0].url, 'https://on.example/v1/chat/completions')
})

test('an already-cancelled call ends immediately with one aborted finish', async () => {
  const { adapter } = chain()
  const fetchDouble = recordingFetch(success())
  const controller = new AbortController()
  controller.abort()
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions({ signal: controller.signal }))))
  const finish = soleFinish(chunks)
  assert.equal(finish.reason.kind, 'aborted')
  assert.equal(finish.reason.failure.code, 'ABORTED')
  assert.equal(chunks.length, 1)
  assert.equal(fetchDouble.requests.length, 0)
})

test('cancelling mid-stream aborts the turn and keeps what was already said', async () => {
  const { adapter } = chain()
  const stalled = (url, init) => scriptedResponse([
    frameOf({ choices: [{ delta: { content: '说到一半' } }] }),
    (signal) => new Promise((resolve, reject) => {
      if (signal === undefined) return
      // The read may start after the cancel: the listener alone would never fire.
      if (signal.aborted === true) {
        reject(abortError())
        return
      }
      signal.addEventListener('abort', () => reject(abortError()), { once: true })
    }),
  ], { signal: init.signal })
  const fetchDouble = recordingFetch(stalled, success())
  const controller = new AbortController()
  const chunks = await withGlobalFetch(fetchDouble.handler, async () => {
    const seen = []
    for await (const chunk of adapter.stream(callOptions({ signal: controller.signal }))) {
      seen.push(chunk)
      if (chunk.type === 'text-delta') controller.abort()
    }
    return seen
  })
  const finish = soleFinish(chunks)
  assert.equal(finish.reason.kind, 'aborted')
  assert.equal(textOf(chunks), '说到一半')
  assert.equal(fetchDouble.requests.length, 1)
})

test('a cancelled signal between suppliers never starts the next attempt', async () => {
  const { adapter } = chain()
  const controller = new AbortController()
  const fetchDouble = recordingFetch(() => {
    // The user cancels while the first supplier is being contacted.
    controller.abort()
    return jsonResponse(500, { error: { message: 'boom' } })
  }, success())
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions({ signal: controller.signal }))))
  assert.equal(soleFinish(chunks).reason.kind, 'aborted')
  assert.equal(fetchDouble.requests.length, 1)
})

test('a supplier that just failed is tried last on the next turn', async () => {
  // The user's order still wins; the cooldown only stops a dead relay from
  // costing its timeout again on every following turn.
  const { adapter } = chain()
  const first = recordingFetch(jsonResponse(401, { error: { message: 'invalid api key' } }), success())
  await withGlobalFetch(first.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(first.requests.length, 2)

  const second = recordingFetch(success())
  const chunks = await withGlobalFetch(second.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(soleFinish(chunks).reason.kind, 'stop')
  assert.equal(second.requests.length, 1, 'the demoted supplier is not contacted first')
  assert.equal(second.requests[0].url, 'https://b.example/v1/chat/completions')
})

test('a recovered supplier returns to its documented priority', async () => {
  const { adapter } = chain({ cooldownMs: 20 })
  const first = recordingFetch(jsonResponse(401, { error: { message: 'invalid api key' } }), success())
  await withGlobalFetch(first.handler, () => collect(adapter.stream(callOptions())))
  await new Promise((resolve) => setTimeout(resolve, 40))

  const second = recordingFetch(success(), success())
  await withGlobalFetch(second.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(second.requests[0].url, 'https://a.example/v1/chat/completions')
})

test('every supplier cooling down is still tried, and the turn still reports', async () => {
  const { adapter } = chain()
  const first = recordingFetch(
    jsonResponse(401, { error: { message: 'invalid api key' } }),
    jsonResponse(503, { error: { message: 'upstream overloaded' } }),
  )
  await withGlobalFetch(first.handler, () => collect(adapter.stream(callOptions())))

  const second = recordingFetch(
    jsonResponse(401, { error: { message: 'invalid api key' } }),
    jsonResponse(503, { error: { message: 'upstream overloaded' } }),
  )
  const chunks = await withGlobalFetch(second.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(second.requests.length, 2, 'the chain is reordered, never shortened')
  assert.equal(soleFinish(chunks).reason.kind, 'error')
})

test('saving the settings document clears the failure hints', async () => {
  // The user just edited the document, most likely because a supplier failed:
  // the next turn must try their order again instead of the demoted one.
  const { adapter } = chain()
  const first = recordingFetch(jsonResponse(401, { error: { message: 'invalid api key' } }), success())
  await withGlobalFetch(first.handler, () => collect(adapter.stream(callOptions())))
  adapter.resetHealth()

  const second = recordingFetch(success(), success())
  await withGlobalFetch(second.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(second.requests[0].url, 'https://a.example/v1/chat/completions')
})
