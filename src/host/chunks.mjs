/**
 * The dsh-llm stream vocabulary, plus the one error type this plugin throws.
 *
 * The plugin cannot import `@deepseek-ai/dsh-llm` (it is not resolvable from a
 * plugin's own node_modules), so the shapes below are restated here from
 * `lib/types/assistant-stream.js` and `lib/types/adapter-failure.js`. They follow
 * the host's validation exactly — a chunk the host would reject is a bug in this
 * adapter, not a host problem — which is why every constructor is small and every
 * field is spelled out.
 * @module dsh-aihub/host/chunks
 */

/**
 * An error the host recognizes as an LLM failure.
 *
 * `name` and `code` are what the host's failure normalizer reads; `code` is also
 * what the retry policy classifies, so it must come from the host's vocabulary
 * (`AUTH`, `RATE_LIMIT`, `QUOTA`, `SERVER`, `HTTP_<status>`, `TIMEOUT`,
 * `TRANSPORT`, `STREAM_CLOSED`, `MALFORMED_RESPONSE`, `EMPTY_RESPONSE`,
 * `INVALID_REQUEST`, `INVALID_CONFIG`, `ABORTED`).
 */
export class AihubError extends Error {
  /**
   * @param message - operator-facing text; never contains a credential.
   * @param code - one of the host's failure codes.
   * @param options - `status`, `providerRetryAfterMs`, `requestId`, `cause`.
   */
  constructor(message, code, options = {}) {
    super(typeof message === 'string' && message.length > 0 ? message : '未知错误', options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LlmError'
    this.code = typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN'
    if (Number.isInteger(options.status) && options.status >= 100 && options.status <= 599) this.status = options.status
    if (Number.isFinite(options.providerRetryAfterMs) && options.providerRetryAfterMs > 0) {
      this.providerRetryAfterMs = options.providerRetryAfterMs
    }
    if (typeof options.requestId === 'string' && options.requestId.length > 0) this.requestId = options.requestId
    // The host reads the code off the error only for its own error classes; for
    // everything else it trusts this frozen snapshot, and only when the
    // snapshot's code agrees with `this.code`. Carrying it keeps `AUTH` from
    // degrading to `UNKNOWN` when the throw escapes the adapter boundary.
    this.failure = this.snapshotFailure()
  }

  /** The failure snapshot the host's normalizer validates. */
  snapshotFailure() {
    const failure = { message: this.message, code: this.code }
    if (this.status !== undefined) failure.status = this.status
    if (this.providerRetryAfterMs !== undefined) failure.providerRetryAfterMs = this.providerRetryAfterMs
    if (this.requestId !== undefined) failure.requestId = this.requestId
    return Object.freeze(failure)
  }
}

/**
 * Turn any thrown value into the failure snapshot the host validates.
 *
 * Built here rather than left to the host because the host can only recover a
 * code from errors it recognizes; anything else degrades to `UNKNOWN`, which
 * loses the difference between "wrong key" and "provider is down".
 * @param error - the thrown value.
 * @param fallbackCode - code to use when the error carries none.
 * @returns `{ message, code, status?, providerRetryAfterMs?, requestId? }`.
 */
export function failureOf(error, fallbackCode = 'UNKNOWN') {
  const source = isObject(error) ? error : {}
  const snapshot = isObject(source.failure) ? source.failure : {}
  const failure = {
    message: nonEmpty(source.message) ?? nonEmpty(snapshot.message) ?? '未知错误',
    code: nonEmpty(source.code) ?? nonEmpty(snapshot.code) ?? fallbackCode,
  }
  const status = statusCode(source.status) ?? statusCode(snapshot.status)
  if (status !== undefined) failure.status = status
  const retry = retryAfter(source.providerRetryAfterMs) ?? retryAfter(snapshot.providerRetryAfterMs)
  if (retry !== undefined) failure.providerRetryAfterMs = retry
  const requestId = nonEmpty(source.requestId) ?? nonEmpty(snapshot.requestId)
  if (requestId !== undefined) failure.requestId = requestId
  return failure
}

/** Start one content block. `index` must be a non-negative safe integer. */
export function blockStart(index, blockType) {
  return { type: 'block-start', index, blockType }
}

export function textDelta(index, text) {
  return { type: 'text-delta', index, text }
}

export function reasoningDelta(index, text) {
  return { type: 'reasoning-delta', index, text }
}

/**
 * One slice of a tool call.
 *
 * `name` is omitted once the block is known: repeating it on every fragment is
 * what the host's accumulator uses to tell fragments of one call from two.
 */
export function toolCallDelta(index, id, name, argumentsDelta) {
  const chunk = { type: 'tool-call-delta', index, id, argumentsDelta }
  if (typeof name === 'string' && name.length > 0) chunk.name = name
  return chunk
}

/** Close one content block with its assembled value. */
export function blockEnd(index, block) {
  return { type: 'block-end', index, block }
}

/** A usage snapshot the host will accept, or `undefined` when nothing was reported. */
export function makeUsage({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) {
  const input = count(inputTokens)
  const output = count(outputTokens)
  const read = count(cacheReadTokens)
  const write = count(cacheWriteTokens)
  if (input === undefined && output === undefined && read === undefined && write === undefined) return undefined
  const usage = {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    // The host bills and displays the total, and providers disagree about whether
    // cache reads are already inside `input`; the host's own adapters add the
    // cache counters on top, so this adapter does the same.
    totalTokens: (input ?? 0) + (output ?? 0) + (read ?? 0) + (write ?? 0),
  }
  if (read !== undefined) usage.cacheReadTokens = read
  if (write !== undefined) usage.cacheWriteTokens = write
  return usage
}

export function usageChunk(usage) {
  return { type: 'usage', usage }
}

/** A terminal chunk that ends the turn normally. */
export function finishOk(kind) {
  return { type: 'finish', reason: { kind } }
}

/** A terminal chunk that ends the turn badly. Only finish chunks carry a reason. */
export function finishFailure(kind, failure) {
  return { type: 'finish', reason: { kind, failure } }
}

export function isFinish(chunk) {
  return isObject(chunk) && chunk.type === 'finish'
}

function isObject(value) {
  return typeof value === 'object' && value !== null
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function statusCode(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

function retryAfter(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
