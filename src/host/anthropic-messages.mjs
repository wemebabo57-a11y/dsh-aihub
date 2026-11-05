/**
 * The Anthropic Messages dialect.
 *
 * Differs from Chat Completions in ways that matter to the translating layer:
 * the response is a stream of typed events rather than a stream of deltas, tool
 * arguments arrive as partial JSON text on a block that was announced with an
 * empty `input`, and every `tool_result` must open the user turn that answers it.
 * @module dsh-aihub/host/anthropic-messages
 */
import {
  AihubError,
  blockEnd,
  blockStart,
  finishOk,
  makeUsage,
  reasoningDelta,
  textDelta,
  toolCallDelta,
  usageChunk,
} from './chunks.mjs'
import { normalizeTurns } from './messages.mjs'

export const api = 'anthropic-messages'

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Path appended to the supplier's base URL.
 *
 * Users paste whatever the provider's docs call the base URL, and Anthropic's
 * own examples already end in `/v1`; appending `/v1` blindly produces `/v1/v1`
 * and a 404, so the version segment is only added when it is missing.
 */
export function endpoint(baseURL) {
  const trimmed = baseURL.replace(/\/+$/, '')
  return /\/v1$/.test(trimmed) ? `${trimmed}/messages` : `${trimmed}/v1/messages`
}

/** Anthropic wants both headers; an empty key still needs the version one. */
export function authHeaders(apiKey) {
  const headers = { 'anthropic-version': ANTHROPIC_VERSION }
  if (apiKey !== '') headers['x-api-key'] = apiKey
  return headers
}

/**
 * Build the request body.
 * @param options.maxTokens - required by the wire; the adapter always resolves
 *   one from the model config before calling this.
 */
export async function buildBody({ supplier, system, messages, tools, maxTokens, temperature, stop, images, signal }) {
  const { systemText, turns } = await normalizeTurns({ messages, system, images, signal })
  const body = {
    model: supplier.model,
    max_tokens: maxTokens,
    stream: true,
    messages: toMessages(turns),
  }
  if (systemText !== '') body.system = systemText
  if (typeof temperature === 'number' && Number.isFinite(temperature)) body.temperature = temperature
  if (Array.isArray(stop) && stop.length > 0) body.stop_sequences = stop
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools.map(toTool)
  return JSON.stringify(body)
}

/**
 * Serialize neutral turns as Messages turns.
 *
 * Consecutive same-role turns are merged because Messages rejects two user
 * turns in a row, and tool results are hoisted to the front of their turn: a
 * `tool_result` must appear before any other block of the turn that answers it.
 */
function toMessages(turns) {
  const messages = []
  const push = (role, blocks) => {
    if (blocks.length === 0) return
    const previous = messages.length > 0 ? messages[messages.length - 1] : undefined
    if (previous !== undefined && previous.role === role) previous.content.push(...blocks)
    else messages.push({ role, content: blocks })
  }
  for (const turn of turns) {
    if (turn.role === 'assistant') push('assistant', assistantBlocks(turn.parts))
    else if (turn.role === 'tool') push('user', toolResultBlocks(turn.parts))
    else push('user', userBlocks(turn.parts))
  }
  for (const message of messages) {
    if (message.role !== 'user') continue
    const results = message.content.filter((block) => block.type === 'tool_result')
    if (results.length === 0 || message.content[0].type === 'tool_result') continue
    message.content = results.concat(message.content.filter((block) => block.type !== 'tool_result'))
  }
  return messages
}

function userBlocks(parts) {
  const blocks = []
  for (const part of parts) {
    if (part.kind === 'text') {
      if (part.text !== '') blocks.push({ type: 'text', text: part.text })
    } else if (part.kind === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: part.mediaType, data: part.base64 },
      })
    }
  }
  return blocks
}

function assistantBlocks(parts) {
  const blocks = []
  for (const part of parts) {
    if (part.kind === 'text') {
      if (part.text !== '') blocks.push({ type: 'text', text: part.text })
    } else if (part.kind === 'tool-call') {
      // An empty id would make the matching tool_result unmatchable, and the
      // provider rejects the whole request over it.
      if (part.id === '') continue
      blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: parseArguments(part.arguments) })
    }
  }
  return blocks
}

function toolResultBlocks(parts) {
  const blocks = []
  for (const part of parts) {
    if (part.kind !== 'tool-result') continue
    if (part.toolCallId === '') continue
    const block = {
      type: 'tool_result',
      tool_use_id: part.toolCallId,
      content: [{ type: 'text', text: part.text === '' ? '(no output)' : part.text }],
    }
    if (part.isError === true) block.is_error = true
    blocks.push(block)
  }
  return blocks
}

/** Replay arguments must be an object here, not a JSON string. */
function parseArguments(text) {
  try {
    const value = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value
  } catch {
    // Fall through: a broken historical argument is replayed as an empty object
    // so the conversation keeps going instead of failing on old data.
  }
  return {}
}

function toTool(tool) {
  const fn = {
    name: tool.name,
    input_schema: isObject(tool.parameters) ? tool.parameters : { type: 'object', properties: {} },
  }
  if (typeof tool.description === 'string' && tool.description !== '') fn.description = tool.description
  return fn
}

/**
 * Translate the SSE frames of one attempt into host chunks.
 * @param frames - `{ event, data }` frames from {@link module:dsh-aihub/host/sse}.
 * @param context - `{ label }`, used in diagnostics.
 */
export async function* translate(frames, context = {}) {
  const label = typeof context.label === 'string' ? context.label : '上游'
  let nextIndex = 0
  let contentBlocks = 0
  let done = false
  let stopReason
  /** Wire block index → the block it produced. */
  const open = new Map()
  /** Every tool block, in creation order, for the end-of-stream checks. */
  const toolBlocks = []
  const totals = {}

  const keyOf = (index) => (Number.isSafeInteger(index) ? String(index) : '0')

  const startBlock = (wireIndex, content) => {
    const record = { index: nextIndex++ }
    const type = typeof content?.type === 'string' ? content.type : ''
    if (type === 'text' || type === 'thinking') {
      record.kind = type === 'text' ? 'text' : 'reasoning'
      record.text = ''
      open.set(keyOf(wireIndex), record)
      contentBlocks += 1
      return [blockStart(record.index, record.kind)]
    }
    if (type === 'tool_use') {
      record.kind = 'tool-call'
      record.id = typeof content.id === 'string' && content.id !== '' ? content.id : `call-${record.index}`
      record.name = typeof content.name === 'string' ? content.name : ''
      record.arguments = ''
      open.set(keyOf(wireIndex), record)
      toolBlocks.push(record)
      contentBlocks += 1
      return [
        blockStart(record.index, 'tool-call'),
        toolCallDelta(record.index, record.id, record.name === '' ? undefined : record.name, ''),
      ]
    }
    // `redacted_thinking` and any future block type carry nothing the host can
    // replay, but the block still has to be tracked so its deltas are ignored.
    record.kind = 'ignored'
    open.set(keyOf(wireIndex), record)
    return []
  }

  const appendDelta = (wireIndex, delta) => {
    const record = open.get(keyOf(wireIndex))
    if (record === undefined) return []
    const type = typeof delta?.type === 'string' ? delta.type : ''
    if (type === 'text_delta' && record.kind === 'text') {
      const text = typeof delta.text === 'string' ? delta.text : ''
      if (text === '') return []
      record.text += text
      return [textDelta(record.index, text)]
    }
    if (type === 'thinking_delta' && record.kind === 'reasoning') {
      const text = typeof delta.thinking === 'string' ? delta.thinking : ''
      if (text === '') return []
      record.text += text
      return [reasoningDelta(record.index, text)]
    }
    if (type === 'input_json_delta' && record.kind === 'tool-call') {
      const text = typeof delta.partial_json === 'string' ? delta.partial_json : ''
      if (text === '') return []
      record.arguments += text
      return [toolCallDelta(record.index, record.id, undefined, text)]
    }
    // `signature_delta` and `citations_delta` are replay metadata we cannot use.
    return []
  }

  const closeBlock = (wireIndex) => {
    const key = keyOf(wireIndex)
    const record = open.get(key)
    if (record === undefined) return []
    open.delete(key)
    if (record.kind === 'text') return [blockEnd(record.index, { type: 'text', text: record.text })]
    if (record.kind === 'reasoning') return [blockEnd(record.index, { type: 'reasoning', text: record.text })]
    if (record.kind !== 'tool-call') return []
    // A call with no arguments still needs valid JSON text: the host parses it.
    const args = record.arguments === '' ? '{}' : record.arguments
    record.arguments = args
    return [blockEnd(record.index, { type: 'tool-call', id: record.id, name: record.name, arguments: args })]
  }

  for await (const frame of frames) {
    const data = typeof frame?.data === 'string' ? frame.data.trim() : ''
    let payload
    if (data !== '') {
      try {
        payload = JSON.parse(data)
      } catch {
        throw new AihubError(`${label}的 SSE 数据不是合法 JSON`, 'MALFORMED_RESPONSE')
      }
    }
    if (!isObject(payload)) continue
    const type = typeof payload.type === 'string' ? payload.type : ''
    if (type === 'error') throw inBandError(payload.error)
    if (type === 'message_start') {
      recordUsage(totals, isObject(payload.message) ? payload.message.usage : undefined)
      continue
    }
    if (type === 'content_block_start') {
      yield* startBlock(payload.index, payload.content_block)
      // A block can be delivered complete in its start event (providers do this
      // for short text and for cached thinking), so its initial content counts.
      const content = payload.content_block
      if (isObject(content) && content.type === 'text' && typeof content.text === 'string' && content.text !== '') {
        const record = open.get(keyOf(payload.index))
        record.text += content.text
        yield textDelta(record.index, content.text)
      }
      continue
    }
    if (type === 'content_block_delta') {
      yield* appendDelta(payload.index, payload.delta)
      continue
    }
    if (type === 'content_block_stop') {
      yield* closeBlock(payload.index)
      continue
    }
    if (type === 'message_delta') {
      recordUsage(totals, payload.usage)
      if (typeof payload.delta?.stop_reason === 'string') stopReason = payload.delta.stop_reason
      continue
    }
    if (type === 'message_stop') {
      done = true
      break
    }
    if (type === 'ping') continue
    // Unknown event types are ignored on purpose: providers add fields, and a
    // turn must not die because a relay invented a new event.
  }

  if (!done) throw new AihubError(`${label}的流在 message_stop 之前中断了`, 'STREAM_CLOSED')
  let kind = mapStop(stopReason)
  if (kind !== 'max-tokens') {
    for (const record of toolBlocks) {
      if (record.name === '') throw new AihubError(`${label}返回了一个没有名字的工具调用，无法执行`, 'MALFORMED_RESPONSE')
      try {
        JSON.parse(record.arguments)
      } catch {
        throw new AihubError(`${label}的工具调用参数不是合法 JSON`, 'MALFORMED_RESPONSE')
      }
    }
  }
  if (kind === 'stop' && contentBlocks === 0) throw new AihubError(`${label}返回了空响应`, 'EMPTY_RESPONSE')
  // A relay may stop with `end_turn` while tool calls are in flight; the agent
  // loop only runs tools when the finish says so, hence the evidence override.
  if (kind === 'stop' && toolBlocks.length > 0) kind = 'tool-calls'
  const usage = makeUsage({
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cacheRead,
    cacheWriteTokens: totals.cacheWrite,
  })
  if (usage !== undefined) yield usageChunk(usage)
  yield finishOk(kind)
}

function mapStop(reason) {
  if (reason === 'tool_use') return 'tool-calls'
  if (reason === 'max_tokens') return 'max-tokens'
  // `end_turn`, `stop_sequence`, `refusal` and `pause_turn` all end a turn
  // without a reason the host models separately.
  return 'stop'
}

/**
 * Messages reports prompt/output counts twice: exact prefill numbers in
 * `message_start`, then a corrected `output_tokens` in `message_delta`.
 */
function recordUsage(totals, raw) {
  if (!isObject(raw)) return
  if (Number.isFinite(raw.input_tokens)) totals.input = raw.input_tokens
  if (Number.isFinite(raw.output_tokens)) totals.output = raw.output_tokens
  if (Number.isFinite(raw.cache_read_input_tokens)) totals.cacheRead = raw.cache_read_input_tokens
  if (Number.isFinite(raw.cache_creation_input_tokens)) totals.cacheWrite = raw.cache_creation_input_tokens
}

function inBandError(raw) {
  const error = isObject(raw) ? raw : {}
  const message =
    typeof error.message === 'string' && error.message !== ''
      ? error.message
      : '上游在流里返回了错误'
  const marker = typeof error.type === 'string' ? error.type.toLowerCase() : ''
  if (marker === 'authentication_error' || marker === 'permission_error') return new AihubError(message, 'AUTH')
  if (marker === 'rate_limit_error') return new AihubError(message, 'RATE_LIMIT')
  if (marker === 'overloaded_error') return new AihubError(message, 'SERVER')
  if (marker === 'invalid_request_error') return new AihubError(message, 'INVALID_REQUEST')
  if (marker === 'request_too_large') return new AihubError(message, 'CONTEXT_WINDOW_EXCEEDED')
  return new AihubError(message, 'SERVER')
}

function isObject(value) {
  return typeof value === 'object' && value !== null
}