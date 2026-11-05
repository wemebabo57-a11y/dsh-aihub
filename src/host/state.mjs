/**
 * The `state` document codec — the only module that knows the v1 JSON shape.
 *
 * The settings panel writes one JSON string and the adapter reads it on every
 * call, so this module sits on two very different paths. Reads are total: a
 * half-written or hand-edited document must degrade to "no models" instead of
 * throwing inside the host's config path. Writes are strict: a document the
 * adapter could not serve is rejected while it is still a settings error rather
 * than a mystery failure during a conversation.
 * @module dsh-aihub/host/state
 */

/** Model ids are routing keys — they travel through `options.model` — so they must be boring. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Display names are free text, but bounded so one document cannot bloat the picker. */
const NAME_MAX = 80

const CONTEXT_WINDOW = Object.freeze({ min: 1000, max: 2_000_000, fallback: 128_000 })
const MAX_TOKENS = Object.freeze({ min: 1, max: 131_072, fallback: 8192 })

/** Wire dialects the adapter speaks; the first entry is what a missing `api` means. */
export const APIS = Object.freeze(['openai-completions', 'anthropic-messages'])

/**
 * The empty hub. Frozen because every degradation path returns this very object,
 * and a caller mutating it would poison the rest of the process.
 */
export const EMPTY_STATE = Object.freeze({ version: 1, models: Object.freeze([]) })

/**
 * Parse one document defensively.
 *
 * Never throws: a broken document is indistinguishable from an unconfigured hub
 * for every consumer downstream, and one bad save must not take the host down.
 * @param text - raw `state` value as stored in the profile patch.
 * @returns a normalized document, or {@link EMPTY_STATE}.
 */
export function parseState(text) {
  try {
    const document = decode(text)
    if (document === undefined) return EMPTY_STATE
    const models = []
    const seen = new Set()
    for (const entry of document.models) {
      const model = normalizeModel(entry)
      // Two models sharing an id make `options.model` ambiguous, and the host
      // rejects a catalog with duplicate ids outright — dropping the later one
      // keeps the rest of the hub usable.
      if (model === undefined || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
    // Unrecognized top-level keys survive: a newer panel may store fields this
    // version does not understand, and it must still find them after a save.
    return { ...document, version: 1, models }
  } catch {
    return EMPTY_STATE
  }
}

/**
 * Read the live config reference into a string.
 *
 * The field is a plain string in the resolved config, but it is handed to this
 * module before the schema has necessarily run (the write hook sees the raw
 * candidate), so a getter-shaped reference is read rather than rejected.
 * @param ref - a string, a `{ get() }` reference, or nothing at all.
 * @returns the raw text, `''` when there is none.
 */
export function readStateText(ref) {
  if (typeof ref === 'string') return ref
  if (ref === undefined || ref === null) return ''
  if (typeof ref.get === 'function') {
    try {
      const value = ref.get()
      return typeof value === 'string' ? value : ''
    } catch {
      // A throwing getter is a broken config, not a reason to fail the host.
      return ''
    }
  }
  if (typeof ref.value === 'string') return ref.value
  return ''
}

/**
 * Validate a document on the write path.
 *
 * Returns instead of throwing for the empty string: clearing the hub is a legal
 * edit, and every rule below is about a document that claims to describe models.
 * @param text - the candidate `state` text.
 * @throws {Error} a Chinese diagnosis that the settings surface shows verbatim.
 */
export function validateState(text) {
  if (text === undefined || text === null) return
  if (typeof text !== 'string') throw fail('state 必须是字符串')
  const trimmed = text.trim()
  if (trimmed === '') return

  let document
  try {
    document = JSON.parse(trimmed)
  } catch (error) {
    throw fail(`不是合法的 JSON（${firstLine(error?.message)}）`)
  }
  if (!isPlainObject(document)) throw fail('顶层必须是一个对象')
  if (document.version !== undefined && document.version !== 1) {
    throw fail(`version 只支持 1，收到 ${describe(document.version)}`)
  }
  if (!Array.isArray(document.models)) throw fail('models 必须是数组')

  const modelIds = new Set()
  document.models.forEach((model, position) => {
    const where = `第 ${position + 1} 个模型`
    if (!isPlainObject(model)) throw fail(`${where}不是一个对象`)
    if (typeof model.id !== 'string' || !ID_PATTERN.test(model.id)) {
      throw fail(`${where}的 id 必须是 1–64 位字母、数字、下划线或连字符（收到 ${describe(model.id)}）`)
    }
    const id = `${where}（${model.id}）`
    if (modelIds.has(model.id)) throw fail(`模型 id 重复：${model.id}`)
    modelIds.add(model.id)

    if (typeof model.name !== 'string' || model.name.trim().length === 0) throw fail(`${id}缺少显示名称`)
    if (model.name.trim().length > NAME_MAX) throw fail(`${id}的显示名称超过 ${NAME_MAX} 个字符`)
    if (model.contextWindow !== undefined) requireInteger(model.contextWindow, CONTEXT_WINDOW, `${id}的上下文窗口`)
    if (model.maxTokens !== undefined) requireInteger(model.maxTokens, MAX_TOKENS, `${id}的输出上限`)
    if (model.vision !== undefined && typeof model.vision !== 'boolean') throw fail(`${id}的 vision 必须是布尔值`)

    if (!Array.isArray(model.suppliers) || model.suppliers.length === 0) throw fail(`${id}至少要有一个供应方`)
    const supplierIds = new Set()
    let enabled = 0
    model.suppliers.forEach((supplier, index) => {
      const at = `${id}的第 ${index + 1} 个供应方`
      if (!isPlainObject(supplier)) throw fail(`${at}不是一个对象`)
      if (typeof supplier.id !== 'string' || !ID_PATTERN.test(supplier.id)) {
        throw fail(`${at}的 id 必须是 1–64 位字母、数字、下划线或连字符（收到 ${describe(supplier.id)}）`)
      }
      const named = `${at}（${supplier.id}）`
      if (supplierIds.has(supplier.id)) throw fail(`${id}内供应方 id 重复：${supplier.id}`)
      supplierIds.add(supplier.id)
      if (supplier.label !== undefined && typeof supplier.label !== 'string') throw fail(`${named}的标签必须是字符串`)
      if (supplier.api !== undefined && !APIS.includes(supplier.api)) {
        throw fail(`${named}的 api 只能是 ${APIS.join(' 或 ')}（收到 ${describe(supplier.api)}）`)
      }
      if (normalizeBaseURL(supplier.baseURL) === undefined) {
        throw fail(`${named}的 Base URL 必须是 http/https 地址（收到 ${describe(supplier.baseURL)}）`)
      }
      if (typeof supplier.model !== 'string' || supplier.model.trim() === '') {
        throw fail(`${named}缺少供应方侧的模型 id`)
      }
      if (supplier.apiKey !== undefined && typeof supplier.apiKey !== 'string') throw fail(`${named}的 API Key 必须是字符串`)
      if (supplier.headers !== undefined && !isPlainObject(supplier.headers)) throw fail(`${named}的 headers 必须是对象`)
      if (supplier.headers !== undefined) {
        for (const [header, value] of Object.entries(supplier.headers)) {
          if (typeof value !== 'string') throw fail(`${named}的 headers.${header} 必须是字符串`)
        }
      }
      if (supplier.enabled !== undefined && typeof supplier.enabled !== 'boolean') throw fail(`${named}的 enabled 必须是布尔值`)
      if (supplier.enabled !== false) enabled += 1
    })
    // Without an enabled endpoint the model would appear in the picker and then
    // fail every single call, so it must not be saved at all.
    if (enabled === 0) throw fail(`${id}至少要有一个启用的供应方`)
  })
}

/** Decode the text into a v1 document, or `undefined` when it is not one. */
function decode(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isPlainObject(parsed)) return undefined
  // A future version is not interpretable here; refusing to guess beats sending
  // requests built from half-understood settings.
  if (parsed.version !== undefined && parsed.version !== 1) return undefined
  if (!Array.isArray(parsed.models)) return undefined
  return parsed
}

/** Normalize one model entry, or drop it when it cannot be served. */
function normalizeModel(entry) {
  if (!isPlainObject(entry)) return undefined
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (!ID_PATTERN.test(id)) return undefined
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (name === '') return undefined
  const suppliers = []
  if (Array.isArray(entry.suppliers)) {
    for (const candidate of entry.suppliers) {
      const supplier = normalizeSupplier(candidate)
      if (supplier !== undefined) suppliers.push(supplier)
    }
  }
  // A model without a usable supplier stays visible on purpose: hiding it would
  // leave the user with an empty picker and no hint about what broke. The
  // adapter reports it per call instead.
  return {
    ...entry,
    id,
    name: name.slice(0, NAME_MAX),
    contextWindow: clampInteger(entry.contextWindow, CONTEXT_WINDOW),
    maxTokens: clampInteger(entry.maxTokens, MAX_TOKENS),
    vision: entry.vision === true,
    suppliers,
  }
}

/** Normalize one supplier entry, or drop it when the adapter could not call it. */
function normalizeSupplier(entry) {
  if (!isPlainObject(entry)) return undefined
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (!ID_PATTERN.test(id)) return undefined
  const baseURL = normalizeBaseURL(entry.baseURL)
  if (baseURL === undefined) return undefined
  const model = typeof entry.model === 'string' ? entry.model.trim() : ''
  if (model === '') return undefined
  // An unknown protocol is a typo, not a dialect we can guess at; a missing one
  // is the documented default.
  if (entry.api !== undefined && !APIS.includes(entry.api)) return undefined
  return {
    ...entry,
    id,
    label: typeof entry.label === 'string' ? entry.label.trim() : '',
    api: APIS.includes(entry.api) ? entry.api : APIS[0],
    baseURL,
    model,
    // Keys are pasted, so surrounding whitespace is almost certainly an accident;
    // a header value with a stray newline would make fetch throw.
    apiKey: typeof entry.apiKey === 'string' ? entry.apiKey.trim() : '',
    headers: normalizeHeaders(entry.headers),
    enabled: entry.enabled !== false,
  }
}

/** Keep only the string→string header pairs a user explicitly set. */
function normalizeHeaders(headers) {
  if (!isPlainObject(headers)) return {}
  const normalized = {}
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string' && name !== '') normalized[name] = value
  }
  return normalized
}

/**
 * Normalize a base URL: http(s) only, trailing slashes dropped.
 * @returns the normalized URL, or `undefined` when it is not usable.
 */
function normalizeBaseURL(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed === '') return undefined
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  return trimmed
}

/** Clamp an integer into `{ min, max }`, falling back when it is not a number. */
function clampInteger(value, bounds) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)))
}

/** Write-path variant of {@link clampInteger}: out-of-range values are errors, not corrections. */
function requireInteger(value, bounds, label) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw fail(`${label}必须是整数`)
  if (value < bounds.min || value > bounds.max) throw fail(`${label}必须在 ${bounds.min}–${bounds.max} 之间`)
}

function fail(detail) {
  return new Error(`AI Hub 设置无法保存：${detail}`)
}

function firstLine(text) {
  const line = typeof text === 'string' ? text.split('\n')[0] : ''
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 39)}…` : value)
  if (value === undefined) return '空'
  try {
    const text = JSON.stringify(value) ?? String(value)
    return text.length > 40 ? `${text.slice(0, 39)}…` : text
  } catch {
    return typeof value
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
