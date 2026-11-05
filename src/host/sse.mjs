/**
 * Server-sent-events framing, shared by both wire dialects.
 *
 * The dialects differ only in what they put inside `data:` and whether they use
 * `event:` names; the framing itself is identical, so it lives here once. The
 * reader is injected instead of taken from a Response so the adapter can wrap
 * every read in its own idle deadline (contract §4.3) and the tests can drive the
 * parser from a plain array.
 * @module dsh-aihub/host/sse
 */

import { AihubError } from './chunks.mjs'

/** One unbounded frame would be a memory leak dressed up as a slow provider. */
const DEFAULT_MAX_FRAME_BYTES = 1 << 20

/**
 * Read one SSE stream as frames.
 * @param read - resolves the next body chunk (`{ done, value }`), already subject
 *   to the caller's idle deadline.
 * @param options - `maxFrameBytes`, `label` used in diagnostics.
 * @returns `{ event?, data, id? }` in wire order; comment-only frames are skipped.
 */
export async function* readSse(read, options = {}) {
  const decoder = new TextDecoder()
  const limit = Number.isSafeInteger(options.maxFrameBytes) ? options.maxFrameBytes : DEFAULT_MAX_FRAME_BYTES
  const label = typeof options.label === 'string' ? options.label : '上游'
  let buffer = ''
  for (;;) {
    const result = await read()
    if (result === undefined || result === null) break
    if (result.done === true) break
    const piece = typeof result.value === 'string' ? result.value : decoder.decode(result.value, { stream: true })
    // Normalize line endings once per append so a `\r\n` split across two network
    // chunks is still recognized after the second chunk arrives.
    buffer = (buffer + piece).replace(/\r\n?/g, '\n')
    let cut = buffer.indexOf('\n\n')
    while (cut >= 0) {
      const frame = parseFrame(buffer.slice(0, cut))
      buffer = buffer.slice(cut + 2)
      if (frame !== undefined) yield frame
      cut = buffer.indexOf('\n\n')
    }
    if (buffer.length > limit) {
      throw new AihubError(`${label}的 SSE 帧超过 ${limit} 字节，无法继续解析`, 'MALFORMED_RESPONSE')
    }
  }
  buffer = (buffer + decoder.decode()).replace(/\r\n?/g, '\n')
  // A stream may end right after a final frame without the closing blank line.
  if (buffer.trim() !== '') {
    const frame = parseFrame(buffer)
    if (frame !== undefined) yield frame
  }
}

/**
 * Parse one frame.
 * @param text - frame body, line endings already normalized.
 * @returns the frame, or `undefined` for comments and keep-alives.
 */
function parseFrame(text) {
  let event
  let id
  let data = ''
  let sawData = false
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      // Multi-line data is joined with newlines, per the SSE spec.
      data = sawData ? `${data}\n${value}` : value
      sawData = true
    } else if (field === 'event') {
      event = value
    } else if (field === 'id') {
      id = value
    }
  }
  if (!sawData && event === undefined) return undefined
  const frame = { data }
  if (event !== undefined) frame.event = event
  if (id !== undefined) frame.id = id
  return frame
}
