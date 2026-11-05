/**
 * LlmMessage[] → the neutral turns both wire dialects serialize.
 *
 * The host's message model is richer than any wire protocol: it carries reasoning
 * blocks (which a request cannot replay without a provider signature),
 * tool-addition/tool-removal markers (the tools travel in the request body
 * instead) and attachment refs (the bytes live outside the message). Translating
 * that once, here, keeps each dialect a pure serializer.
 * @module dsh-aihub/host/messages
 */

/**
 * Flatten host messages into system text plus ordered turns.
 * @param options.messages - host messages (`{ role, content: Block[] }`).
 * @param options.system - the host's rendered system prompt.
 * @param options.images - optional attachment reader: `read(ref, signal)`, resolving
 *   to `{ mediaType, base64 }` or `undefined`; missing bytes degrade to text.
 * @param options.signal - the consumer's abort signal, forwarded to attachment reads.
 * @returns `{ systemText, turns }`, a turn being `{ role, parts }`.
 */
export async function normalizeTurns({ messages, system, images, signal } = {}) {
  let systemText = typeof system === 'string' ? system.trim() : ''
  const turns = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isObject(message)) continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const role = message.role
    if (role === 'system' || role === 'developer') {
      // The host may render the prompt as its own message or hand it over
      // separately; either way both dialects accept exactly one system slot.
      systemText = joinParagraphs(systemText, textOf(blocks))
      continue
    }
    if (role === 'user') {
      const parts = await partsOf(blocks, { images, signal, allowImages: true, allowToolCalls: false })
      if (parts.length > 0) turns.push({ role: 'user', parts })
      continue
    }
    if (role === 'assistant') {
      // Images in recorded assistant turns are not replayable: neither dialect
      // accepts them, so they degrade to text instead of failing the request.
      const parts = await partsOf(blocks, { images, signal, allowImages: false, allowToolCalls: true })
      if (parts.length > 0) turns.push({ role: 'assistant', parts })
      continue
    }
    if (role === 'tool') {
      turns.push({
        role: 'tool',
        parts: [{
          kind: 'tool-result',
          toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : '',
          text: textOf(blocks),
          isError: message.isError === true,
        }],
      })
    }
  }
  return { systemText, turns }
}

/** Convert one message's blocks, resolving images when the role allows them. */
async function partsOf(blocks, { images, signal, allowImages, allowToolCalls }) {
  const parts = []
  for (const block of blocks) {
    if (!isObject(block)) continue
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.length > 0) parts.push({ kind: 'text', text: block.text })
      continue
    }
    if (block.type === 'tool-call') {
      if (!allowToolCalls) continue
      parts.push({
        kind: 'tool-call',
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : '',
        // The host stores arguments as the JSON text the model produced; keep
        // that text so a dialect can pass it through without a lossy re-encode.
        arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
      })
      continue
    }
    if (block.type === 'image') {
      // `offloaded` images already carry a placeholder text block produced by
      // the host, so adding another one here would duplicate it.
      if (block.offloaded === true) continue
      const ref = isObject(block.attachment) ? block.attachment : undefined
      const resolved = allowImages ? await readImage(images, ref, signal) : undefined
      if (resolved === undefined) {
        parts.push({ kind: 'text', text: imagePlaceholder(ref, block) })
        continue
      }
      parts.push({ kind: 'image', mediaType: resolved.mediaType, base64: resolved.base64 })
      continue
    }
    if (block.type === 'file') {
      const ref = isObject(block.attachment) ? block.attachment : {}
      parts.push({ kind: 'text', text: `[file not sent: ${nameOf(ref)}]` })
      continue
    }
    // reasoning / tool-addition / tool-removal and unknown future blocks carry
    // nothing a wire protocol can replay.
  }
  return parts
}

/** Ask the attachment channel for bytes; every failure degrades to text. */
async function readImage(images, ref, signal) {
  if (ref === undefined || typeof images?.read !== 'function') return undefined
  try {
    const resolved = await images.read(ref, signal)
    if (!isObject(resolved)) return undefined
    if (typeof resolved.mediaType !== 'string' || typeof resolved.base64 !== 'string') return undefined
    if (resolved.base64 === '') return undefined
    return resolved
  } catch {
    // A broken attachment must never fail the conversation (contract §4.3).
    return undefined
  }
}

function imagePlaceholder(ref, block) {
  const described = describeRef(ref)
  return `[image not sent: ${described}${block?.offloaded === true ? ', offloaded' : ''}]`
}

function describeRef(ref) {
  if (!isObject(ref)) return 'unknown image'
  const details = [nameOf(ref)]
  if (typeof ref.mediaType === 'string' && ref.mediaType.length > 0) details.push(ref.mediaType)
  if (Number.isSafeInteger(ref.width) && Number.isSafeInteger(ref.height) && ref.width > 0 && ref.height > 0) {
    details.push(`${ref.width}x${ref.height}`)
  }
  return details.filter((value) => typeof value === 'string' && value.length > 0).join(', ')
}

function nameOf(ref) {
  if (typeof ref?.name === 'string' && ref.name.length > 0) return ref.name
  if (typeof ref?.attachmentId === 'string' && ref.attachmentId.length > 0) return ref.attachmentId
  return 'unknown attachment'
}

/** Concatenate a message's text blocks, ignoring everything else. */
function textOf(blocks) {
  const texts = []
  for (const block of blocks) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.join('\n').trim()
}

function joinParagraphs(a, b) {
  if (b === '') return a
  return a === '' ? b : `${a}\n\n${b}`
}

function isObject(value) {
  return typeof value === 'object' && value !== null
}