/**
 * The OpenAI Chat Completions dialect.
 *
 * Written against the wire as OpenAI documents it plus what DeepSeek/Moonshot
 * style relays actually send: reasoning arrives as `reasoning_content`, tool
 * calls arrive as indexed fragments that may precede or follow text, and the
 * terminal `finish_reason` is sometimes missing when a relay just closes the
 * stream. Everything emitted here is already in the host's StreamChunk
 * vocabulary, so the adapter never inspects wire JSON.
 * @module dsh-aihub/host/openai-completions
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

export const api = 'openai-completions'

/** Path appended to the supplier's base URL. */
export function endpoint(baseURL) {
  return `${baseURL}/chat/completions`
}

/** The dialect's credential header; an empty key means "send no credential". */
export function authHeaders(apiKey) {
  return apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }
}

/**
 * Build the request body.
 * @param options.tokenLimitField - `max_tokens` (default) or
 *   `max_completion_tokens`; the adapter retries with the latter when a server
 *   names it in a 400 (OpenAI's newest models reject the old spelling).
 * @returns the JSON body as text.
 */
export async function buildBody({
  supplier,
  system,
  messages,
  tools,
  maxTokens,
  temperature,
  stop,
  images,
  signal,
  tokenLimitField,
}) {
  const { systemText, turns } = await normalizeTurns({ messages, system, images, signal })
  const body = {
    model: supplier.model,
    stream: true,
    // Without this most gateways report `usage: null` in every chunk and the
    // host can never show token counts. Servers that reject the field say so by
    // name in a 400, which is exactly what the adapter's retry keys off.
    stream_options: { include_usage: true },
    messages: toMessages(systemText, turns),
  }
  const field = tokenLimitField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens'
  if (maxTokens !== undefined) body[field] = maxTokens
  if (typeof temperature === 'number' && Number.isFinite(temperature)) body.temperature = temperature
  if (Array.isArray(stop) && stop.length > 0) body.stop = stop
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools.map(toTool)
  return JSON.stringify(body)
}

/** Serialize neutral turns as Chat Completions messages. */
function toMessages(systemText, turns) {
  const messages = []
  // Chat Completions tolerates several system messages, but gateways differ, so
  // all prompt text is folded into a single leading message.
  if (systemText !== '') messages.push({ role: 'system', content: systemText })
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      const texts = []
      const calls = []
      for (const part of turn.parts) {
        if (part.kind === 'text') texts.push(part.text)
        else if (part.kind === 'tool-call') {
          calls.push({ id: part.id, type: 'function', function: { name: part.name, arguments: part.arguments } })
        }
      }
      const text = texts.join('\n')
      if (text === '' && calls.length === 0) continue
      const message = { role: 'assistant', content: text === '' ? null : text }
      if (calls.length > 0) message.tool_calls = calls
      messages.push(message)
      continue
    }
    // One `tool` message answers exactly one call, so a tool turn fans out.
    for (const part of turn.parts) {
      if (part.kind !== 'tool-result') continue
      messages.push({
        role: 'tool',
        tool_call_id: part.toolCallId,
        content: part.text === '' ? '(no output)' : part.text,
      })
    }
    const content = userContent(turn.parts.filter((part) => part.kind !== 'tool-result'))
    if (content !== undefined) messages.push({ role: 'user', content })
  }
  return messages
}

/** A user message is a plain string until it has to carry images. */
function userContent(parts) {
  const texts = []
  const images = []
  for (const part of parts) {
    if (part.kind === 'text') texts.push(part.text)
    else if (part.kind === 'image') images.push(part)
  }
  if (texts.length === 0 && images.length === 0) return undefined
  const text = texts.join('\n')
  if (images.length === 0) return text
  const content = []
  if (text !== '') content.push({ type: 'text', text })
  for (const image of images) {
    content.push({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } })
  }
  return content
}

function toTool(tool) {
  const fn = { name: tool.name }
  if (typeof tool.description === 'string' && tool.description !== '') fn.description = tool.description
  fn.parameters = isObject(tool.parameters) ? tool.parameters : { type: 'object', properties: {} }
  return { type: 'function', function: fn }
}

/**
 * Translate the SSE frames of one attempt into host chunks.
 * @param frames - `{ data }` frames from {@link module:dsh-aihub/host/sse}.
 * @param context - `{ label }`, used in diagnostics; throws on protocol damage so
 *   the adapter can decide between failing over and ending the turn.
 */
export async function* translate(frames, context = {}) {
  const label = typeof context.label === 'string' ? context.label : '上游'
  let nextIndex = 0
  let open
  let finishReason
  let usage
  let sawDone = false
  let blockCount = 0
  /** Wire tool-call slot → the block it produced. */
  const calls = new Map()

  const closeOpen = () => {
    if (open === undefined) return []
    const block = open.kind === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text }
    const chunk = blockEnd(open.index, block)
    open = undefined
    return [chunk]
  }

  const ensureBlock = (kind) => {
    if (open !== undefined && open.kind === kind) return []
    const chunks = closeOpen()
    open = { index: nextIndex++, kind, text: '' }
    blockCount += 1
    chunks.push(blockStart(open.index, kind))
    return chunks
  }

  const appendText = (kind, text) => {
    const chunks = ensureBlock(kind)
    open.text += text
    chunks.push(kind === 'text' ? textDelta(open.index, text) : reasoningDelta(open.index, text))
    return chunks
  }

  const appendCalls = (fragments) => {
    const chunks = []
    for (const fragment of fragments) {
      if (!isObject(fragment)) continue
      const slot = Number.isSafeInteger(fragment.index) ? fragment.index : 0
      const name = typeof fragment.function?.name === 'string' ? fragment.function.name : ''
      let call = calls.get(slot)
      if (call === undefined) {
        // A tool call is its own block, so any open text block ends here.
        chunks.push(...closeOpen())
        const index = nextIndex++
        call = {
          index,
          id: typeof fragment.id === 'string' && fragment.id !== '' ? fragment.id : `call-${index}`,
          name,
          arguments: '',
        }
        calls.set(slot, call)
        blockCount += 1
        chunks.push(blockStart(index, 'tool-call'))
        chunks.push(toolCallDelta(index, call.id, name === '' ? undefined : name, ''))
      } else if (name !== '' && call.name === '') {
        // A relay may deliver the name after the block started; the host accepts
        // a late name fragment, so it is forwarded as its own delta.
        call.name = name
        chunks.push(toolCallDelta(call.index, call.id, name, ''))
      }
      const fragmentText = typeof fragment.function?.arguments === 'string' ? fragment.function.arguments : ''
      if (fragmentText !== '') {
        call.arguments += fragmentText
        chunks.push(toolCallDelta(call.index, call.id, undefined, fragmentText))
      }
    }
    return chunks
  }

  for await (const frame of frames) {
    const data = typeof frame?.data === 'string' ? frame.data.trim() : ''
    if (data === '') continue
    if (data === '[DONE]') {
      sawDone = true
      break
    }
    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      throw new AihubError(`${label}的 SSE 数据不是合法 JSON`, 'MALFORMED_RESPONSE')
    }
    if (!isObject(payload)) continue
    if (payload.error !== undefined) throw inBandError(payload.error)
    const reported = readUsage(payload.usage)
    if (reported !== undefined) usage = reported
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined
    if (!isObject(choice)) continue
    const delta = isObject(choice.delta) ? choice.delta : {}
    const reasoning =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : ''
    if (reasoning !== '') yield* appendText('reasoning', reasoning)
    if (typeof delta.content === 'string' && delta.content !== '') yield* appendText('text', delta.content)
    const fragments = []
    if (Array.isArray(delta.tool_calls)) fragments.push(...delta.tool_calls)
    // Legacy single-call delta still sent by some older compatible servers.
    if (isObject(delta.function_call)) fragments.push({ index: 0, function: delta.function_call })
    if (fragments.length > 0) yield* appendCalls(fragments)
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
      finishReason = mapFinish(choice.finish_reason)
    }
  }

  yield* closeOpen()
  const toolBlocks = [...calls.values()].sort((left, right) => left.index - right.index)
  for (const call of toolBlocks) {
    if (call.name === '') throw new AihubError(`${label}返回了一个没有名字的工具调用，无法执行`, 'MALFORMED_RESPONSE')
    // Some servers omit `arguments` for a call that takes none; the host parses
    // the block, so the text has to be valid JSON either way.
    const args = call.arguments === '' ? '{}' : call.arguments
    // A truncated call (max-tokens) keeps its partial text on purpose: the host
    // drops tool blocks from a max-tokens answer, and "fixing" the JSON here
    // would hide the truncation from the transcript.
    if (finishReason !== 'max-tokens') {
      try {
        JSON.parse(args)
      } catch {
        throw new AihubError(`${label}的工具调用参数不是合法 JSON`, 'MALFORMED_RESPONSE')
      }
    }
    yield blockEnd(call.index, { type: 'tool-call', id: call.id, name: call.name, arguments: args })
  }

  let kind = finishReason
  if (kind === undefined) {
    // No finish reason and no [DONE]: the connection dropped mid-answer.
    if (!sawDone) throw new AihubError(`${label}的流在结束原因到达之前中断了`, 'STREAM_CLOSED')
    kind = 'stop'
  }
  if (kind === 'stop' && blockCount === 0) throw new AihubError(`${label}返回了空响应`, 'EMPTY_RESPONSE')
  // Relays routinely report `stop` while streaming tool calls; a stop finish
  // would hide the calls from the agent loop, so the observed blocks win.
  if (kind === 'stop' && toolBlocks.length > 0) kind = 'tool-calls'
  if (usage !== undefined) yield usageChunk(usage)
  yield finishOk(kind)
}

/** Wire finish_reason → host FinishReason kind. Unknown values must not break a turn. */
function mapFinish(value) {
  switch (value) {
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool-calls'
    case 'length':
    case 'max_tokens':
      return 'max-tokens'
    default:
      // `stop`, `end_turn`, `content_filter` and anything newer all end the turn
      // without a reason the host models separately.
      return 'stop'
  }
}

function readUsage(raw) {
  if (!isObject(raw)) return undefined
  const cached = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens
  return makeUsage({
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens,
    cacheReadTokens: cached,
  })
}

/** An error delivered inside the stream instead of as an HTTP status. */
function inBandError(raw) {
  const error = isObject(raw) ? raw : {}
  const message =
    typeof error.message === 'string' && error.message !== ''
      ? error.message
      : typeof raw === 'string' && raw !== ''
        ? raw
        : '上游在流里返回了错误'
  const marker = `${typeof error.type === 'string' ? error.type : ''} ${typeof error.code === 'string' ? error.code : ''}`.toLowerCase()
  if (/auth|unauthorized|invalid_api_key|permission/.test(marker)) return new AihubError(message, 'AUTH')
  if (/quota|billing/.test(marker)) return new AihubError(message, 'QUOTA')
  if (/rate.?limit/.test(marker)) return new AihubError(message, 'RATE_LIMIT')
  if (/context_length|maximum context/.test(marker)) return new AihubError(message, 'CONTEXT_WINDOW_EXCEEDED')
  if (/invalid_request|invalid_parameter|bad_request/.test(marker)) return new AihubError(message, 'INVALID_REQUEST')
  return new AihubError(message, 'SERVER')
}

function isObject(value) {
  return typeof value === 'object' && value !== null
}