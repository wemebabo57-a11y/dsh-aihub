/**
 * Wire translation, end to end: hand-written SSE in, host chunks out.
 *
 * Each test asserts the request the provider would receive and the chunk
 * vocabulary the host consumes, because "the agent can use it" is exactly the
 * join between those two.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAihubAdapter } from '../../src/host/adapter.mjs'
import {
  collect,
  modelFixture,
  recordingFetch,
  recordingLogger,
  sseResponse,
  soleFinish,
  stateWith,
  supplierFixture,
  textOf,
  typesOf,
  withGlobalFetch,
} from './support/helpers.mjs'

const USER_TURN = { role: 'user', content: [{ type: 'text', text: '你好' }] }

function adapterFor(models, options = {}) {
  const logger = recordingLogger()
  const adapter = createAihubAdapter({
    route: 'aihub',
    readState: () => stateWith(models),
    attachments: options.attachments,
    logger,
    timeouts: options.timeouts,
  })
  return { adapter, logger }
}

function callOptions(overrides = {}) {
  return { provider: 'aihub', model: 'm_1', messages: [USER_TURN], maxTokens: 64, ...overrides }
}

const OPENAI_TEXT_ANSWER = [
  { choices: [{ delta: { content: '你好' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  { usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } },
  'DONE',
]

test('an OpenAI-compatible answer becomes text chunks, usage, then one stop finish', async () => {
  const { adapter } = adapterFor([modelFixture()])
  const fetchDouble = recordingFetch(sseResponse(OPENAI_TEXT_ANSWER))
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions({ system: '你是助手' }))))
  assert.deepEqual(typesOf(chunks), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(chunks[0].blockType, 'text')
  assert.equal(textOf(chunks), '你好')
  assert.deepEqual(chunks[2].block, { type: 'text', text: '你好' })
  assert.deepEqual(chunks[3].usage, { inputTokens: 12, outputTokens: 3, totalTokens: 19, cacheReadTokens: 4 })
  const finish = soleFinish(chunks)
  assert.deepEqual(finish.reason, { kind: 'stop' })
  assert.equal(fetchDouble.requests.length, 1)
})

test('the OpenAI request carries the dialect headers, URL and body', async () => {
  const { adapter } = adapterFor([modelFixture()])
  const fetchDouble = recordingFetch(sseResponse(OPENAI_TEXT_ANSWER))
  await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions({ system: '你是助手' }))))
  const [{ url, init }] = fetchDouble.requests
  assert.equal(url, 'https://upstream.example/v1/chat/completions')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer sk-test-secret-value')
  assert.equal(init.headers['content-type'], 'application/json')
  assert.equal(init.headers.accept, 'text/event-stream')
  assert.equal(typeof init.headers['user-agent'], 'string')
  assert.ok(init.headers['user-agent'].length > 0)
  const body = JSON.parse(init.body)
  assert.equal(body.model, 'gpt-test')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.max_tokens, 64)
  assert.deepEqual(body.messages[0], { role: 'system', content: '你是助手' })
  assert.deepEqual(body.messages[1], { role: 'user', content: '你好' })
})

test('a missing maxTokens falls back to the model output budget', async () => {
  const { adapter } = adapterFor([modelFixture({ maxTokens: 777 })])
  const fetchDouble = recordingFetch(sseResponse(OPENAI_TEXT_ANSWER))
  await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream({ provider: 'aihub', model: 'm_1', messages: [USER_TURN] })))
  assert.equal(JSON.parse(fetchDouble.requests[0].init.body).max_tokens, 777)
})

test('reasoning and tool calls map onto block vocabulary the agent can execute', async () => {
  const { adapter } = adapterFor([modelFixture()])
  const answer = [
    { choices: [{ delta: { reasoning_content: '先想一想' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    'DONE',
  ]
  const fetchDouble = recordingFetch(sseResponse(answer))
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions({ tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } }] }))))
  assert.deepEqual(typesOf(chunks), [
    'block-start','reasoning-delta','block-end',
    'block-start','tool-call-delta','tool-call-delta','tool-call-delta','block-end',
    'finish',
  ])
  assert.equal(chunks[0].blockType, 'reasoning')
  assert.equal(chunks[1].text, '先想一想')
  assert.deepEqual(chunks[2].block, { type: 'reasoning', text: '先想一想' })
  assert.equal(chunks[3].blockType, 'tool-call')
  assert.equal(chunks[4].id, 'call_1')
  assert.equal(chunks[4].name, 'read_file')
  assert.equal(chunks[7].block.id, 'call_1')
  assert.equal(chunks[7].block.name, 'read_file')
  assert.equal(chunks[7].block.arguments, '{"path":"a.txt"}')
  assert.equal(soleFinish(chunks).reason.kind, 'tool-calls')
  const body = JSON.parse(fetchDouble.requests[0].init.body)
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } } }])
})

test('a length finish reason becomes max-tokens', async () => {
  const { adapter } = adapterFor([modelFixture()])
  const answer = [
    { choices: [{ delta: { content: 'half an ans' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
    'DONE',
  ]
  const fetchDouble = recordingFetch(sseResponse(answer))
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(soleFinish(chunks).reason.kind, 'max-tokens')
  assert.equal(textOf(chunks), 'half an ans')
})

test('a legacy function_call delta is still delivered as a tool call', async () => {
  const { adapter } = adapterFor([modelFixture()])
  const answer = [
    { choices: [{ delta: { function_call: { name: 'ping', arguments: '{}' } } }] },
    { choices: [{ delta: {}, finish_reason: 'function_call' }] },
    'DONE',
  ]
  const fetchDouble = recordingFetch(sseResponse(answer))
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  const finish = soleFinish(chunks)
  assert.equal(finish.reason.kind, 'tool-calls')
  const block = chunks.find((chunk) => chunk.type === 'block-end')
  assert.equal(block.block.name, 'ping')
  assert.equal(block.block.arguments, '{}')
})

const ANTHROPIC_TEXT_ANSWER = [
  { type: 'message_start', message: { usage: { input_tokens: 9, cache_read_input_tokens: 2 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
  { type: 'message_stop' },
]

test('an Anthropic answer becomes text chunks with the /v1 URL and both headers', async () => {
  const supplier = supplierFixture({ api: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1', model: 'claude-test', apiKey: 'sk-ant-secret' })
  const { adapter } = adapterFor([modelFixture({ suppliers: [supplier] })])
  const fetchDouble = recordingFetch(sseResponse(ANTHROPIC_TEXT_ANSWER))
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions({ system: '你是助手' }))))
  assert.deepEqual(typesOf(chunks), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(textOf(chunks), '你好')
  assert.deepEqual(chunks[3].usage, { inputTokens: 9, outputTokens: 4, totalTokens: 15, cacheReadTokens: 2 })
  assert.equal(soleFinish(chunks).reason.kind, 'stop')
  const [{ url, init }] = fetchDouble.requests
  assert.equal(url, 'https://api.anthropic.com/v1/messages')
  assert.equal(init.headers['x-api-key'], 'sk-ant-secret')
  assert.equal(init.headers['anthropic-version'], '2023-06-01')
  assert.equal(init.headers.authorization, undefined)
  const body = JSON.parse(init.body)
  assert.equal(body.model, 'claude-test')
  assert.equal(body.max_tokens, 64)
  assert.equal(body.stream, true)
  assert.equal(body.system, '你是助手')
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
})

test('a base URL without /v1 gets the version segment exactly once', async () => {
  const supplier = supplierFixture({ api: 'anthropic-messages', baseURL: 'https://relay.example/anthropic' })
  const { adapter } = adapterFor([modelFixture({ suppliers: [supplier] })])
  const fetchDouble = recordingFetch(sseResponse(ANTHROPIC_TEXT_ANSWER))
  await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(fetchDouble.requests[0].url, 'https://relay.example/anthropic/v1/messages')
})

test('an Anthropic tool_use block becomes an executable tool call', async () => {
  const supplier = supplierFixture({ api: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1', model: 'claude-test' })
  const { adapter } = adapterFor([modelFixture({ suppliers: [supplier] })])
  const answer = [
    { type: 'message_start', message: { usage: { input_tokens: 20 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一下' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ]
  const fetchDouble = recordingFetch(sseResponse(answer))
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  assert.deepEqual(typesOf(chunks), [
    'block-start','reasoning-delta','block-end',
    'block-start','tool-call-delta','tool-call-delta','block-end',
    'usage','finish',
  ])
  assert.equal(chunks[4].id, 'toolu_1')
  assert.equal(chunks[4].name, 'read_file')
  assert.deepEqual(chunks[6].block, { type: 'tool-call', id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.txt"}' })
  assert.equal(soleFinish(chunks).reason.kind, 'tool-calls')
})

test('an Anthropic max_tokens stop reason becomes max-tokens', async () => {
  const supplier = supplierFixture({ api: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1', model: 'claude-test' })
  const { adapter } = adapterFor([modelFixture({ suppliers: [supplier] })])
  const answer = [
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'truncated' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  const fetchDouble = recordingFetch(sseResponse(answer))
  const chunks = await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  assert.equal(soleFinish(chunks).reason.kind, 'max-tokens')
  assert.equal(textOf(chunks), 'truncated')
})

test('a tool result and an assistant tool call round-trip through the request', async () => {
  const { adapter } = adapterFor([modelFixture()])
  const fetchDouble = recordingFetch(sseResponse(OPENAI_TEXT_ANSWER))
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '读一下 a.txt' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '文件内容' }] },
  ]
  await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions({ messages }))))
  const body = JSON.parse(fetchDouble.requests[0].init.body)
  assert.deepEqual(body.messages[1], { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] })
  assert.deepEqual(body.messages[2], { role: 'tool', tool_call_id: 'call_1', content: '文件内容' })
})

test('custom supplier headers reach the request and cannot shadow the credential', async () => {
  const supplier = supplierFixture({ headers: { 'X-Tenant': 'me', authorization: 'Bearer wrong' } })
  const { adapter } = adapterFor([modelFixture({ suppliers: [supplier] })])
  const fetchDouble = recordingFetch(sseResponse(OPENAI_TEXT_ANSWER))
  await withGlobalFetch(fetchDouble.handler, () => collect(adapter.stream(callOptions())))
  const { headers } = fetchDouble.requests[0].init
  assert.equal(headers['X-Tenant'], 'me')
  assert.equal(headers.authorization, 'Bearer sk-test-secret-value')
})
