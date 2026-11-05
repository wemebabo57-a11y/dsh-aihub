/**
 * SSE framing: the one part of both dialects that has to survive real network
 * chunking, keep-alives, and a relay that closes without a blank line.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readSse } from '../../src/host/sse.mjs'

/** A read callback over the given string pieces. */
function readsOf(pieces) {
  const encoder = new TextEncoder()
  let index = 0
  return async () => {
    if (index >= pieces.length) return { done: true, value: undefined }
    return { done: false, value: encoder.encode(pieces[index++]) }
  }
}

async function framesOf(pieces) {
  const frames = []
  for await (const frame of readSse(readsOf(pieces))) frames.push(frame)
  return frames
}

test('one frame per blank line, split across arbitrary read boundaries', async () => {
  const frames = await framesOf([
    'data: {"a',
    '":1}\n\ndata: {"b":2}',
    '\n\ndata: [DONE]\n\n',
  ])
  assert.deepEqual(frames.map((frame) => frame.data), ['{"a":1}', '{"b":2}', '[DONE]'])
})

test('CRLF is normalized even when the pair is split across reads', async () => {
  const frames = await framesOf(['data: first\r', '\n\r\n', 'data: second\r\n\r\n'])
  assert.deepEqual(frames.map((frame) => frame.data), ['first', 'second'])
})

test('multi-line data joins with newlines and comments are skipped', async () => {
  const frames = await framesOf([': keep-alive\n\ndata: line one\ndata: line two\n\n'])
  assert.equal(frames.length, 1)
  assert.equal(frames[0].data, 'line one\nline two')
})

test('event and id fields are preserved', async () => {
  const frames = await framesOf(['event: ping\nid: 7\ndata: {}\n\n'])
  assert.deepEqual(frames[0], { data: '{}', event: 'ping', id: '7' })
})

test('a final frame without the closing blank line is still delivered', async () => {
  const frames = await framesOf(['data: {"last":true}'])
  assert.deepEqual(frames.map((frame) => frame.data), ['{"last":true}'])
})

test('one oversized frame fails as a malformed response instead of growing forever', async () => {
  let failure
  try {
    // No blank line: the frame is still accumulating, which is the case the
    // limit protects (a complete frame is parsed and yielded like any other).
    for await (const frame of readSse(readsOf([`data: ${'x'.repeat(64)}`]), { maxFrameBytes: 8, label: '测试供应方' })) {
      void frame
    }
  } catch (error) {
    failure = error
  }
  assert.ok(failure !== undefined)
  assert.equal(failure.code, 'MALFORMED_RESPONSE')
  assert.match(failure.message, /测试供应方/)
})

test('a comment-only frame yields nothing', async () => {
  assert.deepEqual(await framesOf([': ping\n\n']), [])
})
