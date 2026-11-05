/**
 * dsh-aihub browser half — the local draft over the Host's settings document.
 *
 * The Host owns the document. This module owns a working copy of it: edits stay
 * in the browser until save() writes the whole JSON through
 * form.set('state', ...), the one channel docs/contract.md allows. Validation
 * mirrors the Host's validateState so a malformed document is caught inline
 * before the write; the Host stays the second gate and its refusal reason is
 * shown instead of being swallowed by the form.
 *
 * Draft shape vs wire shape: every text field is a string in the draft (that is
 * what an input holds, including a half-typed number), and toPayload() is the
 * single place that turns it into the JSON docs/contract.md section 3 defines.
 * Unknown keys are carried through untouched so a field added by a newer Host
 * survives a round trip through this page.
 * @module dsh-aihub/client/controller
 */

/** Settings namespace; the same id names the Cordis entry and the settings section. */
export const SETTINGS_ENTRY = 'aihub';
/** Locale namespace the section registers its dictionaries under. */
export const SETTINGS_NS = 'settings.aihub';
/** The single volatile field this plugin persists. */
export const STATE_FIELD = 'state';
/** Wire protocols the Host adapter can speak. */
export const API_CHOICES = Object.freeze(['openai-completions', 'anthropic-messages']);
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 8192;
/** Model and supplier ids: contract section 3. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** The apiKey "env:NAME" convention from contract section 3. */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Field bounds; the same numbers the Host enforces. */
export const LIMITS = Object.freeze({
  name: 80,
  label: 60,
  contextWindow: Object.freeze({ min: 1000, max: 2000000 }),
  maxTokens: Object.freeze({ min: 1, max: 131072 }),
});

const MODEL_FIELDS = Object.freeze(['id', 'name', 'contextWindow', 'maxTokens', 'vision', 'suppliers']);
const SUPPLIER_FIELDS = Object.freeze(['id', 'label', 'api', 'baseURL', 'model', 'apiKey', 'headersText', 'enabled']);
const NUMBER_INPUTS = Object.freeze(['contextWindow', 'maxTokens']);

/** JSON-shaped copy; the draft is only ever plain data. */
function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** Key-order-independent text, used to decide whether the draft moved. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

/** Deterministic id for a stored row that lost its own id; keeps re-reads stable. */
function claimId(prefix, taken) {
  for (let index = 0; index < 1000; index += 1) {
    const id = prefix + index;
    if (!taken.has(id)) return id;
  }
  return prefix + 'x';
}

/** Random id for a row the user just created. */
function freshId(prefix, taken) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0').slice(0, 6);
    const id = prefix + suffix;
    if (!taken || !taken.has(id)) return id;
  }
  return prefix + Date.now().toString(36).slice(-6);
}

/** Contract section 3: trailing slashes on baseURL are normalized away. */
function normalizeBaseURL(value) {
  return String(value === undefined || value === null ? '' : value).trim().replace(/\/+$/, '');
}

/** Parse "Name: value" lines into a headers object; null when a line is malformed. */
function parseHeaderText(text) {
  const headers = {};
  const lines = String(text === undefined || text === null ? '' : text).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const cut = trimmed.indexOf(':');
    if (cut <= 0) return null;
    const name = trimmed.slice(0, cut).trim();
    if (name === '' || /\s/.test(name)) return null;
    headers[name] = trimmed.slice(cut + 1).trim();
  }
  return headers;
}

/** Headers object back to editable text, one "Name: value" per line. */
function headerText(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return '';
  return Object.keys(headers).map(name => name + ': ' + String(headers[name])).join('\n');
}

/** Input text for a numeric field: keep digits as typed, default only when absent. */
function draftNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return String(fallback);
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value.trim());
  return NaN;
}

function isIntegerInRange(value, range) {
  const number = toNumber(value);
  return Number.isInteger(number) && number >= range.min && number <= range.max;
}

function isHttpURL(value) {
  const text = normalizeBaseURL(value);
  if (text === '' || /\s/.test(text)) return false;
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch (error) {
    return false;
  }
}

/** Every model/supplier key this page does not edit, carried through on write. */
function unknownKeys(source, known) {
  const rest = {};
  for (const key of Object.keys(source)) {
    if (known.indexOf(key) >= 0) continue;
    rest[key] = cloneJson(source[key]);
  }
  return rest;
}

/** One stored supplier, normalized into editable text with its defaults filled in. */
function normalizeSupplier(supplier, takenIds) {
  const source = supplier && typeof supplier === 'object' ? supplier : {};
  const taken = takenIds instanceof Set ? takenIds : new Set();
  const row = unknownKeys(source, SUPPLIER_FIELDS.concat(['headers']));
  const id = typeof source.id === 'string' && ID_PATTERN.test(source.id) ? source.id : claimId('s_', taken);
  taken.add(id);
  row.id = id;
  row.label = typeof source.label === 'string' ? source.label : '';
  row.api = API_CHOICES.indexOf(source.api) >= 0 ? source.api : API_CHOICES[0];
  row.baseURL = normalizeBaseURL(source.baseURL);
  row.model = typeof source.model === 'string' ? source.model : '';
  row.apiKey = typeof source.apiKey === 'string' ? source.apiKey : '';
  row.headersText = headerText(source.headers);
  row.enabled = source.enabled !== false;
  return row;
}

/** One stored model, normalized into editable text. */
function normalizeModel(model, takenIds) {
  const source = model && typeof model === 'object' ? model : {};
  const taken = takenIds instanceof Set ? takenIds : new Set();
  const row = unknownKeys(source, MODEL_FIELDS);
  const id = typeof source.id === 'string' && ID_PATTERN.test(source.id) ? source.id : claimId('m_', taken);
  taken.add(id);
  row.id = id;
  row.name = typeof source.name === 'string' ? source.name : '';
  row.contextWindow = draftNumber(source.contextWindow, DEFAULT_CONTEXT_WINDOW);
  row.maxTokens = draftNumber(source.maxTokens, DEFAULT_MAX_TOKENS);
  row.vision = source.vision === true;
  const suppliers = Array.isArray(source.suppliers) ? source.suppliers : [];
  const supplierIds = new Set();
  for (const supplier of suppliers) {
    if (supplier && typeof supplier === 'object' && typeof supplier.id === 'string' && ID_PATTERN.test(supplier.id)) supplierIds.add(supplier.id);
  }
  row.suppliers = suppliers.map(supplier => normalizeSupplier(supplier, supplierIds));
  return row;
}

/** A fresh model, ready for a display name and its first supplier. */
export function createModelDraft(takenIds) {
  const taken = new Set(takenIds || []);
  const id = freshId('m_', taken);
  taken.add(id);
  return {
    id,
    name: '',
    contextWindow: String(DEFAULT_CONTEXT_WINDOW),
    maxTokens: String(DEFAULT_MAX_TOKENS),
    vision: false,
    suppliers: [createSupplierDraft([])],
  };
}

/** A fresh supplier row with the default protocol. */
export function createSupplierDraft(takenIds) {
  return {
    id: freshId('s_', new Set(takenIds || [])),
    label: '',
    api: API_CHOICES[0],
    baseURL: '',
    model: '',
    apiKey: '',
    headersText: '',
    enabled: true,
  };
}

/** The empty hub: contract section 3, version 1. */
export function emptyDraft() {
  return { version: 1, models: [] };
}

/** Wire document -> editable draft. */
export function toDraft(parsed) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const draft = unknownKeys(source, ['version', 'models']);
  draft.version = 1;
  const models = Array.isArray(source.models) ? source.models : [];
  const modelIds = new Set();
  for (const model of models) {
    if (model && typeof model === 'object' && typeof model.id === 'string' && ID_PATTERN.test(model.id)) modelIds.add(model.id);
  }
  draft.models = models.map(model => normalizeModel(model, modelIds));
  return draft;
}

/**
 * Read the saved text: total, like the Host read path. Unparseable text is
 * reported instead of thrown, and the page shows an empty hub for it.
 */
export function parseSavedText(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return { draft: emptyDraft(), corrupt: false };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { draft: emptyDraft(), corrupt: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { draft: emptyDraft(), corrupt: true };
  const version = parsed.version === undefined ? 1 : parsed.version;
  if (version !== 1 || !Array.isArray(parsed.models)) return { draft: emptyDraft(), corrupt: true };
  return { draft: toDraft(parsed), corrupt: false };
}

/** Draft -> the exact JSON written to the state field. */
export function toPayload(draft) {
  const source = draft && typeof draft === 'object' ? draft : {};
  const payload = unknownKeys(source, ['version', 'models']);
  payload.version = 1;
  const models = Array.isArray(source.models) ? source.models : [];
  payload.models = models.map(model => {
    const row = unknownKeys(model, MODEL_FIELDS);
    row.id = String(model.id === undefined ? '' : model.id);
    row.name = String(model.name === undefined ? '' : model.name).trim();
    row.contextWindow = toNumber(model.contextWindow);
    row.maxTokens = toNumber(model.maxTokens);
    row.vision = model.vision === true;
    const suppliers = Array.isArray(model.suppliers) ? model.suppliers : [];
    row.suppliers = suppliers.map(supplier => {
      const item = unknownKeys(supplier, SUPPLIER_FIELDS.concat(['headers']));
      item.id = String(supplier.id === undefined ? '' : supplier.id);
      item.label = String(supplier.label === undefined ? '' : supplier.label).trim();
      item.api = API_CHOICES.indexOf(supplier.api) >= 0 ? supplier.api : API_CHOICES[0];
      item.baseURL = normalizeBaseURL(supplier.baseURL);
      item.model = String(supplier.model === undefined ? '' : supplier.model).trim();
      item.apiKey = String(supplier.apiKey === undefined ? '' : supplier.apiKey);
      const headers = parseHeaderText(supplier.headersText);
      if (headers !== null && Object.keys(headers).length > 0) item.headers = headers;
      item.enabled = supplier.enabled !== false;
      return item;
    });
    return row;
  });
  return payload;
}

/**
 * Client-side gate, mirroring the Host's validateState rules.
 * Messages are locale keys plus parameters, so both dictionaries stay in step.
 * @returns {{ path: string, key: string, params?: object }[]}
 */
export function validateDraft(draft) {
  const errors = [];
  const push = (path, key, params) => errors.push(params ? { path, key, params } : { path, key });
  const source = draft && typeof draft === 'object' ? draft : {};
  if (!Array.isArray(source.models)) {
    push('models', 'errModels');
    return errors;
  }
  const seen = new Set();
  source.models.forEach((model, index) => {
    const row = model && typeof model === 'object' ? model : {};
    const at = 'models.' + index;
    const id = String(row.id === undefined ? '' : row.id);
    if (!ID_PATTERN.test(id)) push(at + '.id', 'errModelId');
    else if (seen.has(id)) push(at + '.id', 'errModelIdDuplicate', { id });
    else seen.add(id);
    const name = String(row.name === undefined ? '' : row.name).trim();
    if (name.length < 1 || name.length > LIMITS.name) push(at + '.name', 'errModelName', { max: LIMITS.name });
    if (!isIntegerInRange(row.contextWindow, LIMITS.contextWindow)) {
      push(at + '.contextWindow', 'errContextWindow', { min: LIMITS.contextWindow.min, max: LIMITS.contextWindow.max });
    }
    if (!isIntegerInRange(row.maxTokens, LIMITS.maxTokens)) {
      push(at + '.maxTokens', 'errMaxTokens', { min: LIMITS.maxTokens.min, max: LIMITS.maxTokens.max });
    }
    const suppliers = Array.isArray(row.suppliers) ? row.suppliers : [];
    if (suppliers.length === 0) push(at + '.suppliers', 'errNoSupplier');
    else if (!suppliers.some(supplier => supplier && supplier.enabled !== false)) push(at + '.suppliers', 'errNoEnabled');
    suppliers.forEach((supplier, position) => {
      const item = supplier && typeof supplier === 'object' ? supplier : {};
      const path = at + '.suppliers.' + position;
      if (!ID_PATTERN.test(String(item.id === undefined ? '' : item.id))) push(path + '.id', 'errSupplierId');
      if (String(item.label === undefined ? '' : item.label).trim().length > LIMITS.label) push(path + '.label', 'errSupplierLabel', { max: LIMITS.label });
      if (API_CHOICES.indexOf(item.api) < 0) push(path + '.api', 'errApi');
      if (!isHttpURL(item.baseURL)) push(path + '.baseURL', 'errBaseURL');
      if (String(item.model === undefined ? '' : item.model).trim() === '') push(path + '.model', 'errSupplierModel');
      const apiKey = String(item.apiKey === undefined ? '' : item.apiKey);
      if (apiKey.indexOf('env:') === 0 && !ENV_KEY_PATTERN.test(apiKey.slice(4))) push(path + '.apiKey', 'errApiKeyEnv');
      if (parseHeaderText(item.headersText) === null) push(path + '.headers', 'errHeaders');
    });
  });
  return errors;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/** Human text for a thrown Host/RPC failure, without stack noise. */
function cleanReason(cause) {
  const raw = cause && typeof cause === 'object' && typeof cause.message === 'string' ? cause.message : String(cause === undefined ? '' : cause);
  let text = raw.replace(/\s+/g, ' ').trim();
  const marker = text.lastIndexOf('Error: ');
  if (marker >= 0) text = text.slice(marker + 7).trim();
  if (text.length > 280) text = text.slice(0, 277) + '\u2026';
  return text;
}

function readState(value) {
  if (value && typeof value === 'object' && typeof value[STATE_FIELD] === 'string') return value[STATE_FIELD];
  return '';
}

/**
 * The draft store the settings section renders from.
 *
 * @param form - ctx.configForms.get('aihub'), the Host configuration form.
 * @param options - { probe }: optional diagnostic writer used only after the
 *   form refused a save, because the form turns a refusal into false without
 *   its reason. It returns { ok, reason } and its reason is shown verbatim.
 */
export function createAihubController(form, options) {
  const settings = options && typeof options === 'object' ? options : {};
  const probe = typeof settings.probe === 'function' ? settings.probe : null;
  const listeners = new Set();
  let disposed = false;
  let saving = false;
  let attempted = false;
  let notice = '';
  let reason = '';
  let corrupt = false;
  let status = 'loading';
  let writable = false;
  let savedText = null;
  let baseline = emptyDraft();
  let draft = emptyDraft();
  let touched = [];
  const touchedSet = new Set();
  let snapshot = null;
  let unsubscribe = null;

  const isDirty = () => stableStringify(draft) !== stableStringify(baseline);

  function buildSnapshot() {
    const errors = validateDraft(draft);
    const errorMap = {};
    for (const entry of errors) if (errorMap[entry.path] === undefined) errorMap[entry.path] = entry;
    return Object.freeze({
      status,
      writable,
      draft: deepFreeze(draft),
      dirty: isDirty(),
      saving,
      attempted,
      notice,
      reason,
      corrupt,
      errors: Object.freeze(errors),
      errorMap: Object.freeze(errorMap),
      touched: Object.freeze(touched.slice()),
    });
  }

  function publish() {
    if (disposed) return;
    snapshot = buildSnapshot();
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch (error) {
        // A broken subscriber must not strand the store.
      }
    }
  }

  function adopt(text) {
    const wasDirty = isDirty();
    const parsed = parseSavedText(text);
    savedText = text;
    corrupt = parsed.corrupt;
    baseline = parsed.draft;
    if (!wasDirty || stableStringify(draft) === stableStringify(baseline)) {
      draft = cloneJson(baseline);
      touchedSet.clear();
      touched = [];
      if (!saving) {
        attempted = false;
        notice = '';
        reason = '';
      }
    }
  }

  function refresh() {
    if (disposed) return;
    let host = null;
    try {
      host = form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : null;
    } catch (error) {
      host = null;
    }
    if (!host || typeof host !== 'object') {
      status = 'unavailable';
      writable = false;
      publish();
      return;
    }
    status = host.status === 'ready' ? 'ready' : host.status === 'unavailable' ? 'unavailable' : 'loading';
    writable = host.status === 'ready' && host.writable === true;
    const text = readState(host.value);
    if (text !== savedText) adopt(text);
    publish();
  }

  function mutate(recipe) {
    if (disposed) return;
    const next = cloneJson(draft);
    recipe(next);
    draft = next;
    notice = '';
    reason = '';
    publish();
  }

  function markSaved(text) {
    baseline = cloneJson(draft);
    savedText = text;
    attempted = false;
    touchedSet.clear();
    touched = [];
    notice = 'saved';
    reason = '';
  }

  function touch(path) {
    if (disposed || touchedSet.has(path)) return;
    touchedSet.add(path);
    touched = Array.from(touchedSet);
    publish();
  }

  function discard() {
    if (disposed) return;
    draft = cloneJson(baseline);
    touchedSet.clear();
    touched = [];
    attempted = false;
    notice = '';
    reason = '';
    publish();
  }

  function addModel() {
    mutate(next => {
      next.models.push(createModelDraft(next.models.map(model => model.id)));
    });
  }

  function removeModel(index) {
    mutate(next => {
      next.models.splice(index, 1);
    });
  }

  function updateModelField(index, field, value) {
    mutate(next => {
      const model = next.models[index];
      if (!model) return;
      model[field] = NUMBER_INPUTS.indexOf(field) >= 0 ? String(value) : value;
    });
  }

  function addSupplier(modelIndex) {
    mutate(next => {
      const model = next.models[modelIndex];
      if (!model) return;
      model.suppliers.push(createSupplierDraft(model.suppliers.map(supplier => supplier.id)));
    });
  }

  function removeSupplier(modelIndex, supplierIndex) {
    mutate(next => {
      const model = next.models[modelIndex];
      if (!model) return;
      model.suppliers.splice(supplierIndex, 1);
    });
  }

  function moveSupplier(modelIndex, supplierIndex, delta) {
    mutate(next => {
      const model = next.models[modelIndex];
      if (!model) return;
      const target = supplierIndex + delta;
      if (target < 0 || target >= model.suppliers.length) return;
      const rows = model.suppliers.splice(supplierIndex, 1);
      model.suppliers.splice(target, 0, rows[0]);
    });
  }

  function updateSupplierField(modelIndex, supplierIndex, field, value) {
    mutate(next => {
      const model = next.models[modelIndex];
      const supplier = model ? model.suppliers[supplierIndex] : null;
      if (!supplier) return;
      supplier[field] = field === 'enabled' ? value === true : value;
    });
  }

  async function save() {
    if (disposed || saving) return false;
    if (status !== 'ready' || !writable || !form || typeof form.set !== 'function') return false;
    const errors = validateDraft(draft);
    if (errors.length > 0) {
      attempted = true;
      notice = 'invalid';
      reason = '';
      publish();
      return false;
    }
    const text = JSON.stringify(toPayload(draft));
    saving = true;
    notice = '';
    reason = '';
    publish();
    let accepted = false;
    try {
      accepted = await form.set(STATE_FIELD, text);
    } catch (error) {
      if (!disposed) {
        saving = false;
        notice = 'failed';
        reason = cleanReason(error);
        publish();
      }
      return false;
    }
    if (!disposed) {
      if (accepted === true) {
        markSaved(text);
      } else {
        let answer = null;
        if (probe) {
          try {
            answer = await probe(text);
          } catch (error) {
            answer = { ok: false, reason: cleanReason(error) };
          }
        }
        if (answer && answer.ok === true) {
          markSaved(text);
        } else {
          notice = 'rejected';
          reason = answer ? cleanReason(answer.reason) : '';
        }
      }
      saving = false;
      publish();
    }
    return accepted === true || notice === 'saved';
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = null;
    listeners.clear();
  }

  snapshot = buildSnapshot();
  try {
    if (form && typeof form.subscribe === 'function') unsubscribe = form.subscribe(refresh);
  } catch (error) {
    unsubscribe = null;
  }
  refresh();

  return {
    store: Object.freeze({
      getSnapshot: () => snapshot,
      subscribe(listener) {
        if (disposed || typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
    save,
    discard,
    addModel,
    removeModel,
    updateModelField,
    addSupplier,
    removeSupplier,
    moveSupplier,
    updateSupplierField,
    touch,
    dispose,
  };
}
