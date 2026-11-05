/**
 * Offline doubles for the host surfaces the adapter touches.
 *
 * The suite swaps `globalThis.fetch` and feeds hand-written SSE text so it can
 * prove the adapter without a network and without the kernel package: the
 * response objects below only implement what the adapter actually reads
 * (`ok`, `status`, `headers.get`, `body.getReader`, `text`).
 * @module test/host/support/helpers
 */

/** Response-like object over a scripted body reader. */
export function responseOf({ status = 200, headers = {}, body = null, text = async () => '' } = {}) {
  const map = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    body,
    text,
  }
}

/**
 * A body whose reads return the given steps in order.
 *
 * A string step is sent as UTF-8, an object step is returned verbatim, and a
 * function step is awaited with the request signal so a test can stall a read
 * and let a deadline abort it.
 */
export function scriptedResponse(steps, options = {}) {
  const encoder = new TextEncoder()
  const signal = options.signal
  let index = 0
  const reader = {
    async read() {
      if (index >= steps.length) return { done: true, value: undefined }
      const step = steps[index]
      index += 1
      if (typeof step === 'function') return await step(signal)
      if (typeof step === 'string') return { done: false, value: encoder.encode(step) }
      return step
    },
    async cancel() {
      index = steps.length
    },
  }
  return responseOf({ ...options, body: { getReader: () => reader }, text: async () => '' })
}

/** One SSE frame of text, as the wire spells it. */
export function frameOf(payload) {
  if (typeof payload === 'string') return payload === 'DONE' ? 'data: [DONE]\n\n' : payload
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Split text into two chunks so framing is exercised across a read boundary. */
export function splitOnce(text) {
  if (text.length < 4) return [text]
  const cut = Math.floor(text.length / 2)
  return [text.slice(0, cut), text.slice(cut)]
}

/** An SSE response built from payload objects, `DONE`, or raw frame strings. */
export function sseResponse(payloads, options = {}) {
  const text = payloads.map(frameOf).join('')
  const pieces = options.split === false ? [text] : splitOnce(text)
  return scriptedResponse(pieces, options)
}

/** A non-2xx response carrying a JSON error body. */
export function jsonResponse(status, payload, headers = {}) {
  return responseOf({ status, headers, text: async () => JSON.stringify(payload) })
}

/** A fetch double that never answers; it rejects only when its signal aborts. */
export function hangingFetch() {
  return (url, init) => new Promise((resolve, reject) => {
    const signal = init?.signal
    if (signal === undefined) return
    if (signal.aborted === true) {
      reject(abortError())
      return
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  })
}

/** The error shape `fetch` rejects with when its signal is aborted. */
export function abortError() {
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  return error
}

/** Run `body` while `globalThis.fetch` is replaced, restoring it afterwards. */
export async function withGlobalFetch(handler, body) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await body()
  } finally {
    globalThis.fetch = original
  }
}

/** Drain an async iterable into an array. */
export async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** The chunk types in order, for readable assertions. */
export function typesOf(chunks) {
  return chunks.map((chunk) => chunk.type)
}

/** The single terminal chunk of a stream, asserting there is exactly one and it is last. */
export function soleFinish(chunks) {
  const finishes = chunks.filter((chunk) => chunk.type === 'finish')
  if (finishes.length !== 1) {
    throw new Error(`expected exactly one finish chunk, saw ${finishes.length}: ${JSON.stringify(chunks)}`)
  }
  if (chunks[chunks.length - 1] !== finishes[0]) throw new Error('the finish chunk was not the last chunk')
  return finishes[0]
}

/** Every text delta joined, for asserting the answer body. */
export function textOf(chunks) {
  return chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
}

/** A logger that records instead of printing. */
export function recordingLogger() {
  const warnings = []
  const infos = []
  return {
    warnings,
    infos,
    warn(message) {
      warnings.push(String(message))
    },
    info(message) {
      infos.push(String(message))
    },
  }
}

/** One supplier entry in the settings document. */
export function supplierFixture(overrides = {}) {
  return {
    id: 's_1',
    label: '默认供应方',
    api: 'openai-completions',
    baseURL: 'https://upstream.example/v1',
    model: 'gpt-test',
    apiKey: 'sk-test-secret-value',
    headers: {},
    enabled: true,
    ...overrides,
  }
}

/** One model entry in the settings document. */
export function modelFixture(overrides = {}) {
  return {
    id: 'm_1',
    name: '写作 · 主力',
    contextWindow: 128_000,
    maxTokens: 4096,
    vision: false,
    suppliers: [supplierFixture()],
    ...overrides,
  }
}

/** A parsed settings document holding the given models. */
export function stateWith(models) {
  return { version: 1, models }
}

/** Count how many times a fetch double was called, keeping the request details. */
export function recordingFetch(...responses) {
  const requests = []
  const handler = async (url, init) => {
    requests.push({ url, init })
    const next = responses[requests.length - 1]
    if (next === undefined) throw new Error(`unexpected extra request: ${url}`)
    return typeof next === 'function' ? next(url, init) : next
  }
  return { handler, requests }
}
