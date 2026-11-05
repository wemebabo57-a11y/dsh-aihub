/**
 * The `aihub` route adapter: one route, a user-managed catalog, and a failover
 * chain per model.
 *
 * Three things shape this module:
 *
 * 1. A model is a user-created identity that several upstream suppliers can
 *    serve, so "which supplier" is a runtime decision. The chain is snapshotted
 *    in `prepareCall`, not re-read while chunks flow: a save that reorders
 *    suppliers must not change the chain a running turn fails over through.
 * 2. Failing over is only safe while nothing has been emitted — the host has
 *    already accumulated whatever it received, so a second supplier would
 *    append a second answer to the same message. That boundary is checked in
 *    exactly one place (`generate`), which is also the only place a terminal
 *    chunk is forwarded, so a stream cannot end twice.
 * 3. Keys sit in the settings document in plain text and that document is
 *    logged by the host on config errors, so no diagnostic here ever formats a
 *    key: the resolved credential is used to build one header and to scrub
 *    provider error text, nothing else.
 * @module dsh-aihub/host/adapter
 */

import { AihubError, failureOf, finishFailure, isFinish } from './chunks.mjs'
import * as anthropicMessages from './anthropic-messages.mjs'
import * as openaiCompletions from './openai-completions.mjs'
import { readSse } from './sse.mjs'

/** Wire dialects, keyed by the `api` value the settings document stores. */
const DIALECTS = new Map([
  [openaiCompletions.api, openaiCompletions],
  [anthropicMessages.api, anthropicMessages],
])

/** Contract §4.3 defaults; an embedding host may narrow them for tests. */
export const DEFAULT_TIMEOUTS = Object.freeze({ firstResponseMs: 30_000, idleMs: 120_000 })

/**
 * How long a supplier that failed before producing content is tried last.
 *
 * Without this, a dead relay costs its full first-response deadline (30s) on
 * every single turn: the user waits, then the good supplier answers. The
 * cooldown only reorders — the supplier is still tried when everything else
 * fails, so a provider that comes back never needs a restart or a manual edit.
 */
export const DEFAULT_COOLDOWN_MS = 30_000

/** The attachment store rescales, so a generous cap never upsizes a small image. */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** Used only when the host package cannot be imported — the usual case for a plugin. */
const FALLBACK_USER_AGENT = 'dsh-aihub/0.1.0'

/** Enough of an error body to name the provider's reason; not a whole HTML page. */
const ERROR_BODY_LIMIT = 4096

/** The contract's default output cap, used when a document omits one. */
const DEFAULT_OUTPUT_TOKENS = 8192

/** `apiKey: "env:NAME"` is how the settings document references a secret without storing it. */
const ENV_PREFIX = 'env:'

/**
 * Build the `aihub` adapter.
 * @param options.route - the provider route this adapter is registered under.
 * @param options.readState - returns the parsed settings document (`{ models }`).
 * @param options.attachments - returns the host attachment store, or `undefined`.
 * @param options.logger - Cordis logger (`warn`/`info`); missing methods are ignored.
 * @param options.timeouts - `{ firstResponseMs, idleMs }` overrides, for tests.
 * @param options.fetch - fetch implementation override, for tests.
 * @returns an object shaped like `LlmAdapter` (structural, not a subclass: the
 *   kernel package is not resolvable from a plugin).
 */
export function createAihubAdapter(options = {}) {
  const route = nonEmpty(options.route) ?? 'aihub'
  const readModels = typeof options.readState === 'function' ? options.readState : () => undefined
  const attachments = typeof options.attachments === 'function' ? options.attachments : () => undefined
  const logger = normalizeLogger(options.logger)
  const warn = once(logger.warn)
  const timeouts = {
    firstResponseMs: positiveInteger(options.timeouts?.firstResponseMs, DEFAULT_TIMEOUTS.firstResponseMs),
    idleMs: positiveInteger(options.timeouts?.idleMs, DEFAULT_TIMEOUTS.idleMs),
  }
  const fetchRequest = typeof options.fetch === 'function'
    ? options.fetch
    : (url, init) => globalThis.fetch(url, init)
  const attribution = lazyAttribution()
  // Supplier health is process memory, not settings: it is a hint about this
  // run, and restarting the host is a legitimate way to clear it.
  const cooldowns = new Map()
  const cooldownMs = Number.isSafeInteger(options.cooldownMs) && options.cooldownMs >= 0
    ? options.cooldownMs
    : DEFAULT_COOLDOWN_MS

  /** Live catalog. A half-written document collapses to an empty hub (contract §3). */
  function models() {
    try {
      const state = readModels()
      return Array.isArray(state?.models) ? state.models : []
    } catch (error) {
      logger.warn(`读取设置失败，本次按 0 个模型处理（${describeError(error)}）`)
      return []
    }
  }

  /**
   * One model as `LlmModelInfo`.
   *
   * Both spellings are emitted on purpose: the flat `contextWindow`/`maxTokens`
   * pair is what the catalog contract documents, while the host's call
   * resolution only honors `context.contextWindow` and `defaultMaxTokens` (the
   * flat pair is dropped when it normalizes the catalog). Emitting one without
   * the other either hides the budget or silently ignores it.
   */
  function modelInfo(provider, model) {
    const info = {
      provider,
      id: model.id,
      name: nonEmpty(model.name) ?? model.id,
      inputModalities: model.vision === true ? ['text', 'image'] : ['text'],
    }
    // The host rejects `context` unless it holds a positive integer, so a state
    // that skipped the codec must not be able to produce an invalid catalog.
    const contextWindow = positiveInteger(model.contextWindow, undefined)
    const maxTokens = positiveInteger(model.maxTokens, undefined)
    if (contextWindow !== undefined) {
      info.contextWindow = contextWindow
      info.context = { contextWindow }
    }
    if (maxTokens !== undefined) {
      info.maxTokens = maxTokens
      info.defaultMaxTokens = maxTokens
    }
    return info
  }

  function findModel(modelId) {
    const id = typeof modelId === 'string' ? modelId : ''
    for (const model of models()) {
      if (isObject(model) && model.id === id) return model
    }
    return undefined
  }

  function requireModel(modelId) {
    const model = findModel(modelId)
    if (model === undefined) {
      throw new AihubError(`AI Hub 里没有 id 为「${String(modelId)}」的模型，请先在设置里创建它`, 'INVALID_CONFIG')
    }
    return model
  }

  return {
    /** The route id must be echoed back; `registerAdapter` rejects a mismatch. */
    providerInfo(provider) {
      return { id: nonEmpty(provider) ?? route, name: 'aihub' }
    },

    /** No route-owned policy: the host defaults (5 retries on transient codes) are right here. */
    providerRetryPolicy() {
      return undefined
    },

    /** A saved settings document is a user's fix: forget every failure hint. */
    resetHealth() {
      cooldowns.clear()
    },

    /** Requests are billed by the provider, not by the host, so there is no local pricing table. */
    imageRequestPricing() {
      return undefined
    },

    /** The byte target the request serializer uses for one image. */
    imageRequestTarget(_provider, _model, image) {
      return imageTargetOf(image)
    },

    async listModels(provider) {
      const seen = new Set()
      const catalog = []
      for (const model of models()) {
        if (!isObject(model) || typeof model.id !== 'string' || model.id === '') continue
        // A duplicate id would make the host reject the whole catalog.
        if (seen.has(model.id)) continue
        seen.add(model.id)
        catalog.push(modelInfo(provider, model))
      }
      return catalog
    },

    async resolveModel(provider, modelId) {
      return modelInfo(provider, requireModel(modelId))
    },

    async prepareCall(provider, modelId) {
      const model = requireModel(modelId)
      const suppliers = schedule(model, enabledSuppliers(model))
      return {
        model: modelInfo(provider, model),
        // One dispatch per prepared call; the chain is frozen with it.
        stream: (callOptions) => generate(model, suppliers, callOptions),
      }
    },

    stream(callOptions) {
      // Reached only when a caller dispatches without `prepareCall`. It still has
      // to end with one terminal chunk rather than a throw, because a hand-rolled
      // caller reads chunks instead of the host's failure wrapper.
      const model = isObject(callOptions) ? findModel(callOptions.model) : undefined
      if (model === undefined) {
        const error = new AihubError(`AI Hub 里没有 id 为「${String(callOptions?.model)}」的模型`, 'INVALID_CONFIG')
        return failedStream(error)
      }
      return generate(model, schedule(model, enabledSuppliers(model)), callOptions)
    },
  }

  /**
   * Stable partition into "worth trying now" and "failed recently".
   *
   * The user's document order is the priority; the cooldown only demotes an
   * endpoint that just failed, and it is re-armed (not removed) so a full-chain
   * failure still walks every supplier before reporting.
   */
  function schedule(model, suppliers) {
    if (cooldownMs === 0 || cooldowns.size === 0) return suppliers
    const now = Date.now()
    for (const [key, until] of cooldowns) if (until <= now) cooldowns.delete(key)
    if (cooldowns.size === 0) return suppliers
    const ready = []
    const cooling = []
    for (const supplier of suppliers) {
      const until = cooldowns.get(supplierKey(model, supplier))
      if (until !== undefined && until > now) cooling.push(supplier)
      else ready.push(supplier)
    }
    return cooling.length === 0 ? suppliers : [...ready, ...cooling]
  }

  /** A supplier that answered is healthy again for the next turn. */
  function markHealthy(model, supplier) {
    cooldowns.delete(supplierKey(model, supplier))
  }

  /** A supplier that failed before content is tried last for a while. */
  function markFailed(model, supplier) {
    if (cooldownMs === 0) return
    cooldowns.set(supplierKey(model, supplier), Date.now() + cooldownMs)
    // A long-lived host editing models forever must not grow this map forever.
    if (cooldowns.size > 512) {
      const trimTo = Date.now()
      for (const [key, until] of cooldowns) if (until <= trimTo) cooldowns.delete(key)
      while (cooldowns.size > 256) cooldowns.delete(cooldowns.keys().next().value)
    }
  }

  /** A stream that fails before it starts: one terminal chunk, by contract. */
  async function* failedStream(error) {
    yield finishFailure('error', failureOf(error))
  }

  /**
   * Drive one turn across the model's supplier chain.
   *
   * Decision point 1 (failover vs. stop) is the `delivered` flag: it is raised
   * by the first chunk that leaves this generator, so "nothing emitted yet" and
   * "safe to try the next supplier" are the same fact rather than two flags that
   * can disagree.
   */
  async function* generate(model, suppliers, callOptions) {
    const signal = callOptions?.signal
    const modelLabel = `AI Hub 模型「${nonEmpty(model.name) ?? model.id}」`
    if (suppliers.length === 0) {
      yield finishFailure('error', failureOf(new AihubError(
        `${modelLabel}没有启用的供应方，请在设置里至少启用一个`,
        'INVALID_CONFIG',
      )))
      return
    }
    const failures = []
    for (let index = 0; index < suppliers.length; index += 1) {
      const supplier = suppliers[index]
      if (signal?.aborted === true) {
        yield abortedChunk()
        return
      }
      const label = supplierLabel(supplier)
      const attempt = attemptStream({ model, supplier, callOptions, fetchRequest, attachments, attribution, warn, timeouts })
      let delivered = false
      try {
        for await (const chunk of attempt) {
          if (isFinish(chunk)) {
            // Exactly one terminal chunk per stream: the attempt produced it, and
            // nothing else is forwarded afterwards.
            if (chunk.reason?.kind !== 'error') markHealthy(model, supplier)
            yield chunk
            return
          }
          delivered = true
          yield chunk
        }
        // No terminal chunk means the translation layer is broken, not that the
        // provider failed; still surfaced as a failure rather than a silent stop.
        throw new AihubError(`${label}的流没有以 finish 结束`, 'STREAM_CLOSED')
      } catch (error) {
        if (signal?.aborted === true) {
          yield abortedChunk()
          return
        }
        const failure = failureOf(error, 'SERVER')
        if (delivered) {
          // Decision point 2: content already reached the accumulator, so another
          // supplier would be appended to the same message. End the turn instead.
          warn(`${label}在返回内容之后失败，无法切换供应方（${failure.code}：${failure.message}）`)
          yield finishFailure('error', failure)
          return
        }
        failures.push({ supplier, failure })
        markFailed(model, supplier)
        const next = suppliers[index + 1]
        if (next === undefined) {
          warn(`${label}在返回内容之前失败，且后面没有供应方了（${failure.code}：${failure.message}）`)
        } else {
          warn(`${label}在返回内容之前失败，切换到${supplierLabel(next)}（${failure.code}：${failure.message}）`)
        }
      }
    }
    // Decision point 3: every supplier failed before producing anything. The
    // last failure owns the code (it is what blocked the turn most recently),
    // but the message keeps the whole chain so the user can fix the real one.
    yield finishFailure('error', aggregateFailure(modelLabel, failures))
  }

  /** One supplier, one request: build, send, translate. Throws on any failure. */
  async function* attemptStream({ model, supplier, callOptions, fetchRequest, attachments, attribution, warn, timeouts }) {
    const dialect = DIALECTS.get(supplier.api)
    if (dialect === undefined) {
      throw new AihubError(`${supplierLabel(supplier)}使用了未知协议「${String(supplier.api)}」`, 'INVALID_CONFIG')
    }
    const label = supplierLabel(supplier)
    // Every deadline is enforced by aborting this controller: fetch, body reads
    // and the translate loop all observe it, so a stalled provider cannot pin
    // the turn open (contract §4.3).
    const controller = new AbortController()
    const detach = followSignal(callOptions?.signal, controller)
    const expiry = { reason: undefined }
    let closeBody
    const firstResponse = setTimeout(() => {
      expiry.reason = 'first-response'
      controller.abort()
    }, timeouts.firstResponseMs)
    try {
      const apiKey = resolveApiKey(supplier, warn)
      const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(isObject(supplier.headers) ? supplier.headers : {}),
        // Attribution and the credential come last so a free-form header table
        // cannot drop the identity the contract requires or shadow the key with
        // a differently capitalized `Authorization`.
        ...(await attribution()),
        ...dialect.authHeaders(apiKey),
      }
      const body = await dialect.buildBody({
        supplier,
        system: callOptions?.system,
        messages: callOptions?.messages,
        tools: callOptions?.tools,
        maxTokens: maxTokensOf(model, callOptions),
        temperature: callOptions?.temperature,
        stop: callOptions?.stop,
        images: imageReader({ model, attachments, label, warn }),
        signal: controller.signal,
      })
      const response = await fetchRequest(dialect.endpoint(supplier.baseURL), {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })
      clearTimeout(firstResponse)
      if (!isObject(response)) throw new AihubError(`${label}没有返回响应`, 'TRANSPORT')
      if (response.ok !== true) throw await responseFailure(response, { label, model, supplier, apiKey })
      const bodyStream = readResponseBody(response, {
        idleMs: timeouts.idleMs,
        label,
        onIdle: () => {
          expiry.reason = 'idle'
          controller.abort()
        },
      })
      closeBody = bodyStream.close
      const frames = readSse(bodyStream.read, { label })
      for await (const chunk of dialect.translate(frames, { label })) yield chunk
    } catch (error) {
      throw classifyFailure(error, { signal: callOptions?.signal, expiry: expiry.reason, timeouts, label, model })
    } finally {
      clearTimeout(firstResponse)
      if (closeBody !== undefined) await closeBody()
      detach()
    }
  }
}

/** Suppliers in user order, skipping those the user disabled. */
function enabledSuppliers(model) {
  const suppliers = Array.isArray(model?.suppliers) ? model.suppliers : []
  return suppliers.filter((supplier) => isObject(supplier) && supplier.enabled !== false)
}

/** One attempt's failure summary when the whole chain is exhausted. */
function aggregateFailure(modelLabel, failures) {
  const parts = failures.map(({ failure }, index) => `${index + 1}. ${failure.code}：${failure.message}`)
  // A ten-relay chain would otherwise produce a paragraph; keep the ends, which
  // are the ones the contract requires and the ones users act on.
  const shown = parts.length <= 4
    ? parts
    : [...parts.slice(0, 2), `…（另有 ${parts.length - 4} 个供应方失败）`, ...parts.slice(-2)]
  const last = failures[failures.length - 1].failure
  const failure = {
    message: `${modelLabel}的所有 ${failures.length} 个供应方都失败了：${shown.join('；')}`,
    code: last.code,
  }
  if (last.status !== undefined) failure.status = last.status
  if (last.providerRetryAfterMs !== undefined) failure.providerRetryAfterMs = last.providerRetryAfterMs
  if (last.requestId !== undefined) failure.requestId = last.requestId
  return failure
}

/** The one terminal chunk a cancelled turn ends with. */
function abortedChunk() {
  return finishFailure('aborted', { message: '调用已取消', code: 'ABORTED' })
}

/** Human-facing supplier identity used by every diagnostic. Never includes a key. */
function supplierLabel(supplier) {
  const label = nonEmpty(supplier?.label) ?? nonEmpty(supplier?.id) ?? '未命名供应方'
  const model = nonEmpty(supplier?.model)
  return model === undefined ? `供应方「${label}」` : `供应方「${label}」（${model}）`
}

/**
 * Identity of one supplier inside one model, for the failure cooldown.
 *
 * `id` is the stable key the panel assigns; the endpoint triple covers a
 * document that was written by hand without one. The model id is part of the
 * key so two models on the same provider do not demote each other.
 */
function supplierKey(model, supplier) {
  const supplierId = nonEmpty(supplier?.id)
    ?? `${String(supplier?.baseURL)}|${String(supplier?.model)}|${String(supplier?.api)}`
  return `${String(model?.id)}\u0000${supplierId}`
}

/**
 * Reserve the output budget for one request.
 *
 * Anthropic rejects a body without `max_tokens`, so a document that never went
 * through the settings codec still has to produce a number here.
 */
function maxTokensOf(model, callOptions) {
  return positiveInteger(callOptions?.maxTokens, undefined)
    ?? positiveInteger(model?.maxTokens, undefined)
    ?? DEFAULT_OUTPUT_TOKENS
}

/**
 * Resolve one supplier's credential.
 *
 * `env:NAME` keeps the secret out of the settings document. A missing variable
 * is not an error here: the attempt proceeds unauthenticated and the provider
 * names the real problem, instead of this module guessing.
 */
function resolveApiKey(supplier, warn) {
  const raw = typeof supplier?.apiKey === 'string' ? supplier.apiKey.trim() : ''
  if (!raw.startsWith(ENV_PREFIX)) return raw
  const name = raw.slice(ENV_PREFIX.length).trim()
  const value = name === '' ? undefined : globalThis.process?.env?.[name]
  if (typeof value !== 'string' || value.trim() === '') {
    warn(`${supplierLabel(supplier)}的 apiKey 指向环境变量 ${name === '' ? '(未命名)' : name}，但宿主环境里没有它的值，本次请求不带凭据`)
    return ''
  }
  return value.trim()
}

/** HTTP failure → the host's failure vocabulary, with the provider's own wording kept. */
async function responseFailure(response, { label, model, supplier, apiKey }) {
  const status = Number.isInteger(response.status) ? response.status : 0
  const detail = redact(await readErrorBody(response), [apiKey])
  const message = detail === ''
    ? `${label}返回 HTTP ${status}`
    : `${label}返回 HTTP ${status}：${detail}`
  return new AihubError(message, failureCode(status, detail), {
    status,
    providerRetryAfterMs: retryAfterOf(response),
    requestId: requestIdOf(response),
  })
}

/**
 * Map an HTTP status onto a code the host can route on.
 *
 * The provider-neutral codes come first because the retry policy keys off them:
 * a 429 worded as an empty balance is a terminal quota problem, not a burst.
 */
function failureCode(status, detail) {
  if (status === 402) return 'QUOTA'
  if (status === 401 || status === 403) return isQuotaWording(detail) ? 'QUOTA' : 'AUTH'
  if (status === 429) return isQuotaWording(detail) ? 'QUOTA' : 'RATE_LIMIT'
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    if (isContextOverflow(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
    if (isQuotaWording(detail)) return 'QUOTA'
    return 'INVALID_REQUEST'
  }
  if (status >= 500 && status <= 599) return 'SERVER'
  return `HTTP_${status}`
}

/** The host has a canonical classifier for this wording; it is not importable from a plugin. */
function isContextOverflow(detail) {
  if (detail === '') return false
  return /context[\s_-](?:length|window)/i.test(detail)
    || /(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context/i.test(detail)
    || /(?:prompt|input|request|messages?)[^.]{0,40}too\s+(?:long|large)/i.test(detail)
}

function isQuotaWording(detail) {
  if (detail === '') return false
  return /insufficient[\s_-]+(?:quota|balance|credits?)/i.test(detail)
    || /(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)/i.test(detail)
    || /(?:balance|credits?)[\s_-]+(?:exhausted|depleted)/i.test(detail)
    || /out[\s_-]+of[\s_-]+(?:credits?|budget)/i.test(detail)
}

/** Read at most a screenful of the provider's error body; never let it throw. */
async function readErrorBody(response) {
  try {
    if (typeof response.text === 'function') {
      const text = await response.text()
      return summarizeErrorBody(typeof text === 'string' ? text.slice(0, ERROR_BODY_LIMIT) : '')
    }
    const reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : undefined
    if (reader === undefined) return ''
    try {
      const { value } = await reader.read()
      return summarizeErrorBody(decodeText(value).slice(0, ERROR_BODY_LIMIT))
    } finally {
      try { await reader.cancel() } catch { /* the socket may already be gone */ }
    }
  } catch {
    // The status line alone is enough to fail the attempt.
    return ''
  }
}

/** Pull the provider's reason out of JSON or plain-text error bodies. */
function summarizeErrorBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  let message = text
  try {
    const parsed = JSON.parse(text)
    const nested = parsed?.error
    if (typeof nested === 'string') message = nested
    else if (typeof nested?.message === 'string') message = nested.message
    else if (typeof parsed?.message === 'string') message = parsed.message
  } catch {
    // A relay that answers with HTML gets its text collapsed instead.
  }
  const collapsed = message.replace(/\s+/g, ' ').trim()
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed
}

/** `retry-after` as milliseconds, in either of its two wire spellings. */
function retryAfterOf(response) {
  const raw = headerOf(response, 'retry-after')
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return undefined
  const delta = at - Date.now()
  return delta > 0 ? delta : undefined
}

/** A provider request id is worth surfacing in the failure snapshot for support. */
function requestIdOf(response) {
  return headerOf(response, 'x-request-id') ?? headerOf(response, 'request-id') ?? headerOf(response, 'x-amzn-requestid')
}

function headerOf(response, name) {
  const headers = response?.headers
  if (typeof headers?.get !== 'function') return undefined
  try {
    const value = headers.get(name)
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Wrap the response body so every read carries the idle deadline.
 *
 * A read that never resolves is the failure mode this exists for: the timer
 * aborts the attempt controller, which rejects the pending `read()`, and
 * `classifyFailure` turns that into `TIMEOUT` instead of a hung turn.
 */
function readResponseBody(response, { idleMs, label, onIdle }) {
  const body = response?.body
  const reader = typeof body?.getReader === 'function' ? body.getReader() : undefined
  if (reader === undefined) {
    return {
      async read() {
        throw new AihubError(`${label}的响应没有可读的流（可能被中转改写了），无法继续`, 'MALFORMED_RESPONSE')
      },
      async close() {},
    }
  }
  let timer
  const stop = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  return {
    async read() {
      stop()
      timer = setTimeout(onIdle, idleMs)
      try {
        return await reader.read()
      } finally {
        stop()
      }
    },
    async close() {
      stop()
      try {
        await reader.cancel()
      } catch {
        // Cancelling an already-errored socket is expected.
      }
    },
  }
}

/** Forward the consumer's cancellation into the attempt controller. */
function followSignal(signal, controller) {
  if (!isObject(signal) || typeof signal.addEventListener !== 'function') return () => {}
  if (signal.aborted === true) {
    controller.abort(signal.reason)
    return () => {}
  }
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  return () => {
    try {
      signal.removeEventListener('abort', onAbort)
    } catch {
      // A foreign AbortSignal implementation may not support removal.
    }
  }
}

/**
 * Classify whatever escaped one attempt.
 *
 * Order matters: an aborted consumer outranks a timeout (the user asked first),
 * and an expired deadline outranks the transport error it caused (`fetch`
 * reports a bare `AbortError` for both).
 */
function classifyFailure(error, context) {
  if (error instanceof AihubError) return error
  if (context.signal?.aborted === true) return new AihubError('调用已取消', 'ABORTED')
  if (context.expiry === 'first-response') {
    return new AihubError(`${context.label}在 ${context.timeouts.firstResponseMs}ms 内没有返回响应（首响应超时）`, 'TIMEOUT')
  }
  if (context.expiry === 'idle') {
    return new AihubError(`${context.label}的响应流空闲超过 ${context.timeouts.idleMs}ms`, 'TIMEOUT')
  }
  if (isObject(error) && error.name === 'AbortError') return new AihubError('调用已取消', 'ABORTED')
  return new AihubError(`${context.label}请求失败：${describeError(error)}`, 'TRANSPORT', { cause: error })
}

/**
 * The attachment reader a dialect uses to inline images as base64.
 *
 * Returns `undefined` when the route cannot send bytes at all (no store, or a
 * text-only model), which makes the message projection replace images with
 * placeholder text — the same path a failed read takes. A broken attachment
 * must never fail the conversation (contract §4.4).
 */
function imageReader({ model, attachments, label, warn }) {
  let store
  try {
    store = attachments()
  } catch {
    store = undefined
  }
  const capable = typeof store?.readImageRequest === 'function'
  // The checks live inside `read` on purpose: a warning about images must only
  // appear for a turn that actually carries one, not for every text-only call.
  return {
    async read(ref, signal) {
      // Only a model the user marked as vision-capable may spend bytes on an image.
      if (model.vision !== true) {
        warn(`${label}没有开启视觉，图片将按文本发送`)
        return undefined
      }
      if (!capable) {
        warn(`${label}需要图片但宿主没有可用的附件服务，图片将按文本发送`)
        return undefined
      }
      try {
        const version = await store.readImageRequest(ref, imageTargetOf(ref), signal)
        const base64 = encodeBase64(version?.data)
        if (base64 === undefined) {
          warn(`${label}的图片读取没有返回字节，已按文本发送`)
          return undefined
        }
        const mediaType = nonEmpty(version?.mediaType) ?? nonEmpty(ref?.mediaType) ?? 'image/png'
        return { mediaType, base64 }
      } catch (error) {
        warn(`${label}的图片读取失败，已按文本发送（${describeError(error)}）`)
        return undefined
      }
    },
  }
}

/** The store rescales to this box; small images are served as they are. */
function imageTargetOf(image) {
  return {
    width: positiveInteger(image?.width, undefined) ?? 1024,
    height: positiveInteger(image?.height, undefined) ?? 1024,
    maxBytes: IMAGE_MAX_BYTES,
  }
}

/** Uint8Array → base64, with a non-Node fallback so the browser bundle can reuse this file. */
function encodeBase64(data) {
  if (data === undefined || data === null) return undefined
  const buffer = globalThis.Buffer
  if (typeof buffer?.from === 'function') {
    if (data instanceof Uint8Array) return buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
    if (data instanceof ArrayBuffer) return buffer.from(data).toString('base64')
    if (ArrayBuffer.isView(data)) return buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
    return undefined
  }
  if (!(data instanceof Uint8Array)) return undefined
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary)
}

/** Decode one response body chunk for diagnostics; the SSE path does its own decoding. */
function decodeText(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return new TextDecoder().decode(value)
  } catch {
    return ''
  }
}

/** Remove resolved credentials from provider-controlled text before it can be logged. */
function redact(text, secrets) {
  let result = typeof text === 'string' ? text : ''
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    result = result.split(secret).join('[redacted]')
  }
  return result
}

/** Render any thrown value, including `fetch`'s cause chain, for a diagnostic. */
function describeError(error) {
  const pieces = []
  let current = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === undefined || current === null) break
    const message = messageOf(current)
    if (message !== '' && !pieces.includes(message)) pieces.push(message)
    if (isObject(current) && Array.isArray(current.errors)) {
      for (const member of current.errors) {
        const memberMessage = messageOf(member)
        if (memberMessage !== '' && !pieces.includes(memberMessage)) pieces.push(memberMessage)
      }
    }
    current = isObject(current) ? current.cause : undefined
  }
  return pieces.length === 0 ? '未知错误' : pieces.join('：')
}

function messageOf(value) {
  if (isObject(value) && typeof value.message === 'string' && value.message !== '') return value.message
  try {
    return typeof value === 'string' ? value : String(value)
  } catch {
    return '无法读取的错误'
  }
}

/**
 * `attributionHeaders()` lives in the kernel package, which a plugin cannot
 * import. Try once, then keep the constant: the header is cosmetic, and a
 * failed import must not make every request pay for a rejected resolution.
 */
function lazyAttribution() {
  let cached
  return async function attribution() {
    if (cached !== undefined) return cached
    try {
      const kernel = await import('@deepseek-ai/dsh-llm')
      const headers = typeof kernel.attributionHeaders === 'function' ? kernel.attributionHeaders() : undefined
      cached = isObject(headers) && Object.keys(headers).length > 0 ? headers : { 'user-agent': FALLBACK_USER_AGENT }
    } catch {
      cached = { 'user-agent': FALLBACK_USER_AGENT }
    }
    return cached
  }
}

/** Accept only an object logger that can fail; never let logging break a request. */
function normalizeLogger(logger) {
  const warnFn = typeof logger?.warn === 'function' ? logger.warn.bind(logger) : undefined
  const infoFn = typeof logger?.info === 'function' ? logger.info.bind(logger) : undefined
  const call = (fn, message) => {
    if (fn === undefined) return
    try {
      fn(`aihub: ${message}`)
    } catch {
      // A logger that throws is the host's problem; the request still matters.
    }
  }
  return {
    warn: (message) => call(warnFn, message),
    info: (message) => call(infoFn, message),
  }
}

/** Emit each distinct warning once: one broken attachment should not spam every attempt. */
function once(fn) {
  const seen = new Set()
  return (message) => {
    if (typeof message !== 'string' || seen.has(message)) return
    seen.add(message)
    fn(message)
  }
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isObject(value) {
  return typeof value === 'object' && value !== null
}
