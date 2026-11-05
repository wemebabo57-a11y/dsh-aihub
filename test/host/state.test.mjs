/**
 * The state codec: total reads, strict writes.
 *
 * Every case here is something a half-written patch file or a hand-edited
 * settings document can actually contain, because the whole point of this
 * module is that the host stays up when one of them happens.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_STATE, parseState, readStateText, validateState } from '../../src/host/state.mjs'

const VALID = {
  version: 1,
  models: [{
    id: 'm_1',
    name: '写作 · 主力',
    contextWindow: 128000,
    maxTokens: 8192,
    vision: false,
    suppliers: [{
      id: 's_1',
      label: 'OpenAI 官方',
      api: 'openai-completions',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-5',
      apiKey: 'sk-x',
      headers: {},
      enabled: true,
    }],
  }],
}

test('EMPTY_STATE is the frozen v1 empty hub', () => {
  assert.deepEqual(EMPTY_STATE, { version: 1, models: [] })
  assert.ok(Object.isFrozen(EMPTY_STATE))
})

test('a damaged document degrades to the empty hub instead of throwing', () => {
  const damaged = [
    undefined,
    null,
    42,
    {},
    '',
    '   ',
    '{',
    '{"version":1,',
    '{ half written',
    '[]',
    '"text"',
    '{"version":2,"models":[]}',
    '{"version":1,"models":{}}',
    '{"version":1,"models":null}',
  ]
  for (const text of damaged) {
    assert.deepEqual(parseState(text), EMPTY_STATE, `input: ${String(text)}`)
  }
})

test('parseState fills defaults and normalizes the base URL', () => {
  const parsed = parseState(JSON.stringify({
    version: 1,
    models: [{
      id: 'm_1',
      name: '  主力  ',
      suppliers: [{ id: 's_1', baseURL: 'https://relay.example/v1///', model: ' kimi-k2 ' }],
    }],
  }))
  const [model] = parsed.models
  assert.equal(model.id, 'm_1')
  assert.equal(model.name, '主力')
  assert.equal(model.contextWindow, 128000)
  assert.equal(model.maxTokens, 8192)
  assert.equal(model.vision, false)
  assert.equal(model.suppliers[0].baseURL, 'https://relay.example/v1')
  assert.equal(model.suppliers[0].model, 'kimi-k2')
  assert.equal(model.suppliers[0].api, 'openai-completions', 'a missing api means the default dialect')
  assert.equal(model.suppliers[0].enabled, true)
  assert.equal(model.suppliers[0].label, '')
})

test('parseState keeps unknown fields so a newer panel does not lose them', () => {
  const parsed = parseState(JSON.stringify({
    version: 1,
    futureTopLevel: { keep: true },
    models: [{ id: 'm_1', name: '主力', futureModel: 7, suppliers: [{ id: 's_1', baseURL: 'https://a.example', model: 'x', futureSupplier: 'y' }] }],
  }))
  assert.deepEqual(parsed.futureTopLevel, { keep: true })
  assert.equal(parsed.models[0].futureModel, 7)
  assert.equal(parsed.models[0].suppliers[0].futureSupplier, 'y')
})

test('parseState drops unusable suppliers and models, keeping the rest visible', () => {
  const parsed = parseState(JSON.stringify({
    version: 1,
    models: [
      { id: 'm_good', name: '可用', suppliers: [{ id: 's_1', baseURL: 'https://a.example', model: 'x' }] },
      { id: 'bad id!', name: '非法 id', suppliers: [{ id: 's_1', baseURL: 'https://a.example', model: 'x' }] },
      { id: 'm_noname', name: '   ', suppliers: [{ id: 's_1', baseURL: 'https://a.example', model: 'x' }] },
      { id: 'm_nosupplier', name: '没有供应方', suppliers: [] },
      { id: 'm_dup', name: '第一个', suppliers: [{ id: 's_1', baseURL: 'https://a.example', model: 'x' }] },
      { id: 'm_dup', name: '第二个', suppliers: [{ id: 's_1', baseURL: 'https://a.example', model: 'x' }] },
      { id: 'm_api', name: '未知协议', suppliers: [{ id: 's_1', baseURL: 'https://a.example', model: 'x', api: 'grpc' }] },
    ],
  }))
  assert.deepEqual(parsed.models.map((model) => model.id), ['m_good', 'm_nosupplier', 'm_dup', 'm_api'])
  assert.equal(parsed.models.filter((model) => model.id === 'm_dup')[0].name, '第一个')
  assert.deepEqual(parsed.models.find((model) => model.id === 'm_nosupplier').suppliers, [], 'a model with no usable supplier stays visible')
  assert.deepEqual(parsed.models.find((model) => model.id === 'm_api').suppliers, [], 'an unknown protocol is a typo, not a dialect')
})

test('parseState clamps a numeric budget instead of rejecting the document', () => {
  const parsed = parseState(JSON.stringify({
    version: 1,
    models: [{ id: 'm_1', name: '主力', contextWindow: 12, maxTokens: 999999, suppliers: [{ id: 's_1', baseURL: 'https://a.example', model: 'x' }] }],
  }))
  assert.equal(parsed.models[0].contextWindow, 1000)
  assert.equal(parsed.models[0].maxTokens, 131072)
})

test('parseState accepts the empty document as an empty hub', () => {
  assert.deepEqual(parseState(''), EMPTY_STATE)
  assert.deepEqual(parseState(JSON.stringify({ version: 1, models: [] })), { version: 1, models: [] })
})

test('readStateText reads the three shapes the config can hand over', () => {
  assert.equal(readStateText('{"version":1}'), '{"version":1}')
  assert.equal(readStateText({ get: () => 'abc' }), 'abc')
  assert.equal(readStateText(undefined), '')
  assert.equal(readStateText({ get: () => { throw new Error('broken config') } }), '', 'a throwing getter is a broken config, not a crash')
  assert.equal(readStateText({ get: () => 17 }), '')
  assert.equal(readStateText({ value: 'from-value' }), 'from-value')
})

test('validateState accepts the empty string and a valid document', () => {
  assert.doesNotThrow(() => validateState(''))
  assert.doesNotThrow(() => validateState('   '))
  assert.doesNotThrow(() => validateState(JSON.stringify(VALID)))
  assert.doesNotThrow(() => validateState(undefined))
})

test('validateState rejects what the adapter could not serve, with a Chinese diagnosis', () => {
  const cases = [
    ['{', /不是合法的 JSON/],
    ['[]', /顶层必须是一个对象/],
    [JSON.stringify({ version: 2, models: [] }), /version 只支持 1/],
    [JSON.stringify({ version: 1 }), /models 必须是数组/],
    [JSON.stringify({ version: 1, models: [{ id: 'bad id', name: 'x', suppliers: [] }] }), /id 必须是/],
    [JSON.stringify({ version: 1, models: [{ id: 'm_1', name: '  ', suppliers: [] }] }), /缺少显示名称/],
    [JSON.stringify({ version: 1, models: [{ id: 'm_1', name: 'x'.repeat(81), suppliers: [] }] }), /超过 80 个字符/],
    [JSON.stringify({ version: 1, models: [{ id: 'm_1', name: 'x', contextWindow: 999, suppliers: [] }] }), /上下文窗口必须在/],
    [JSON.stringify({ version: 1, models: [{ id: 'm_1', name: 'x', maxTokens: 0, suppliers: [] }] }), /输出上限必须在/],
    [JSON.stringify({ version: 1, models: [{ id: 'm_1', name: 'x', vision: 'yes', suppliers: [] }] }), /vision 必须是布尔值/],
    [JSON.stringify({ version: 1, models: [{ id: 'm_1', name: 'x', suppliers: [] }] }), /至少要有一个供应方/],
    [JSON.stringify({ version: 1, models: [{ id: 'm_1', name: 'x', suppliers: [{ id: 's_1', baseURL: 'ftp://a', model: 'x' }] }] }), /Base URL 必须是 http\/https 地址/],
    [JSON.stringify({ version: 1, models: [{ id: 'm_1', name: 'x', suppliers: [{ id: 's_1', baseURL: 'https://a', model: '  ' }] }] }), /缺少供应方侧的模型 id/],
    [JSON.stringify({ version: 1, models: [{ id: 'm_1', name: 'x', suppliers: [{ id: 's_1', baseURL: 'https://a', model: 'x', api: 'grpc' }] }] }), /api 只能是/],
    [JSON.stringify({ version: 1, models: [{ id: 'm_1', name: 'x', suppliers: [{ id: 's_1', baseURL: 'https://a', model: 'x', enabled: false }] }] }), /至少要有一个启用的供应方/],
    [JSON.stringify({ version: 1, models: [{ id: 'm_1', name: 'x', suppliers: [{ id: 's_1', baseURL: 'https://a', model: 'x' }] }, { id: 'm_1', name: 'y', suppliers: [{ id: 's_2', baseURL: 'https://a', model: 'x' }] }] }), /模型 id 重复/],
    [JSON.stringify({ version: 1, models: [{ id: 'm_1', name: 'x', suppliers: [{ id: 's_1', baseURL: 'https://a', model: 'x', headers: { a: 1 } }] }] }), /headers.a 必须是字符串/],
  ]
  for (const [text, pattern] of cases) {
    assert.throws(() => validateState(text), (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, pattern)
      assert.match(error.message, /^AI Hub 设置无法保存：/)
      return true
    }, text)
  }
})
