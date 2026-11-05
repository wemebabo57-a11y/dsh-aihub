/**
 * The adapter surface the host calls before a token moves: metadata, catalog,
 * and the preparation snapshot.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAihubAdapter } from '../../src/host/adapter.mjs'
import { parseState } from '../../src/host/state.mjs'
import { modelFixture, recordingLogger, stateWith, supplierFixture } from './support/helpers.mjs'

function adapterFor(models, options = {}) {
  const logger = options.logger ?? recordingLogger()
  const adapter = createAihubAdapter({
    route: 'aihub',
    readState: options.readState ?? (() => stateWith(models)),
    attachments: options.attachments,
    logger,
    timeouts: options.timeouts,
  })
  return { adapter, logger }
}

test('providerInfo echoes the route and carries the requested display name', () => {
  const { adapter } = adapterFor([])
  assert.deepEqual(adapter.providerInfo('aihub'), { id: 'aihub', name: 'aihub' })
  assert.equal(adapter.providerRetryPolicy('aihub'), undefined, 'the host defaults are the policy')
  assert.equal(adapter.imageRequestPricing('aihub', 'm_1'), undefined)
})

test('imageRequestTarget keeps the original size and caps bytes', () => {
  const { adapter } = adapterFor([])
  assert.deepEqual(
    adapter.imageRequestTarget('aihub', 'm_1', { width: 640, height: 480, bytes: 10 }),
    { width: 640, height: 480, maxBytes: 5 * 1024 * 1024 },
  )
  assert.deepEqual(adapter.imageRequestTarget('aihub', 'm_1', {}), { width: 1024, height: 1024, maxBytes: 5 * 1024 * 1024 })
})

test('listModels advertises every model under the route, modalities included', async () => {
  const { adapter } = adapterFor([
    modelFixture({ id: 'm_text', name: '纯文本' }),
    modelFixture({ id: 'm_vision', name: '看图', vision: true, contextWindow: 200000, maxTokens: 16384 }),
  ])
  const catalog = await adapter.listModels('aihub')
  assert.deepEqual(catalog.map((entry) => entry.id), ['m_text', 'm_vision'])
  assert.deepEqual(catalog.map((entry) => entry.provider), ['aihub', 'aihub'])
  assert.deepEqual(catalog[0].inputModalities, ['text'])
  assert.deepEqual(catalog[1].inputModalities, ['text', 'image'])
  assert.equal(catalog[1].contextWindow, 200000)
  assert.equal(catalog[1].maxTokens, 16384)
})

test('a duplicate model id is advertised once — the host rejects the whole catalog otherwise', async () => {
  const duplicateA = modelFixture({ id: 'm_dup', name: '第一个' })
  const duplicateB = modelFixture({ id: 'm_dup', name: '第二个' })
  const { adapter } = adapterFor([duplicateA, duplicateB])
  const catalog = await adapter.listModels('aihub')
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].name, '第一个')
})

test('resolveModel exposes the budget both ways so the host can enforce it', async () => {
  const { adapter } = adapterFor([modelFixture({ id: 'm_1', contextWindow: 64000, maxTokens: 2048 })])
  const info = await adapter.resolveModel('aihub', 'm_1')
  assert.equal(info.provider, 'aihub')
  assert.equal(info.id, 'm_1', 'the resolved id must equal the requested id exactly')
  assert.equal(info.name, '写作 · 主力')
  assert.deepEqual(info.context, { contextWindow: 64000 })
  assert.equal(info.defaultMaxTokens, 2048)
  assert.equal(info.contextWindow, 64000)
  assert.equal(info.maxTokens, 2048)
})

test('resolveModel rejects an unknown id with INVALID_CONFIG and a LlmError name', async () => {
  const { adapter } = adapterFor([modelFixture()])
  await assert.rejects(() => adapter.resolveModel('aihub', 'm_missing'), (error) => {
    assert.equal(error.name, 'LlmError')
    assert.equal(error.code, 'INVALID_CONFIG')
    assert.equal(error.failure.code, 'INVALID_CONFIG', 'the snapshot keeps the code across the host boundary')
    assert.match(error.message, /m_missing/)
    return true
  })
})

test('prepareCall returns the metadata and a one-shot stream', async () => {
  const { adapter } = adapterFor([modelFixture()])
  const prepared = await adapter.prepareCall('aihub', 'm_1')
  assert.equal(prepared.model.id, 'm_1')
  assert.equal(typeof prepared.stream, 'function')
})

test('prepareCall freezes the supplier chain: a later save cannot reroute a running turn', async () => {
  const primary = supplierFixture({ id: 's_a', label: '主线路', baseURL: 'https://a.example/v1' })
  const backup = supplierFixture({ id: 's_b', label: '备用线路', baseURL: 'https://b.example/v1' })
  const models = [modelFixture({ suppliers: [primary, backup] })]
  const { adapter } = adapterFor(models)
  const prepared = await adapter.prepareCall('aihub', 'm_1')
  // The user saves a new order while the turn is still being prepared.
  models[0].suppliers = [backup]
  const requested = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    requested.push(url)
    throw new Error('offline test')
  }
  try {
    for await (const chunk of prepared.stream({ provider: 'aihub', model: 'm_1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
      void chunk
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(requested, ['https://a.example/v1/chat/completions', 'https://b.example/v1/chat/completions'])
})

test('a stream for an unknown model still ends with one terminal chunk instead of throwing', async () => {
  const { adapter } = adapterFor([modelFixture()])
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'aihub', model: 'm_missing' })) chunks.push(chunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'INVALID_CONFIG')
})

test('a throwing settings reference degrades to an empty catalog, not a crash', async () => {
  const { adapter, logger } = adapterFor([], {
    readState: () => {
      throw new Error('patch file is half written')
    },
  })
  assert.deepEqual(await adapter.listModels('aihub'), [])
  assert.equal(logger.warnings.length, 1)
  assert.match(logger.warnings[0], /读取设置失败/)
})

test('a damaged document text is parsed as an empty hub by the real codec', async () => {
  const { adapter } = adapterFor([], { readState: () => parseState('{"version":1,"models":[') })
  assert.deepEqual(await adapter.listModels('aihub'), [])
})

test('a model with no enabled supplier stays in the catalog but cannot be called', async () => {
  const disabled = supplierFixture({ enabled: false })
  const { adapter } = adapterFor([modelFixture({ suppliers: [disabled] })])
  assert.equal((await adapter.listModels('aihub')).length, 1)
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'aihub', model: 'm_1' })) chunks.push(chunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'INVALID_CONFIG')
  assert.match(chunks[0].reason.failure.message, /没有启用的供应方/)
})
