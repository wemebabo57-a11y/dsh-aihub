#!/usr/bin/env node
/**
 * dsh-aihub client half: cheap self-check before shipping a bundle.
 *
 * No dependencies, no browser. It verifies the four things a broken client
 * bundle would break:
 *   1. both dictionaries carry the same keys, and every copy key the view asks
 *      for exists in English and Chinese;
 *   2. the stylesheet uses DSH theme tokens only, with no gradients and no raw
 *      colors, so light and dark palettes both stay readable;
 *   3. the draft rules mirror the Host gate (docs/contract.md section 4.1);
 *   4. client/client.js still exposes the lazy factory ABI, renders through a
 *      fake React, masks API keys by default, and never reaches form.set when
 *      the client gate refuses a save.
 *
 * Run: node scripts/check-ui.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
let passed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    results.push('  ok   ' + label);
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    const detail = message.split('\n').map(line => line.trim()).filter(line => line !== '').slice(0, 6).join(' | ');
    results.push('  FAIL ' + label + ': ' + detail);
  }
}

function read(rel) {
  return readFile(path.join(ROOT, rel), 'utf8');
}

function sourceUrl(rel) {
  return pathToFileURL(path.join(ROOT, rel)).href;
}

const controllerSrc = await read('src/client/controller.mjs');
const viewSrc = await read('src/client/view.mjs');
const indexSrc = await read('src/client/index.mjs');
const controller = await import(sourceUrl('src/client/controller.mjs'));
const view = await import(sourceUrl('src/client/view.mjs'));
const entry = await import(sourceUrl('src/client/index.mjs'));
const EN = view.EN;
const ZH = view.ZH;

/* ------------------------------------------------------------------ fixtures */

const VALID_DOC = {
  version: 1,
  topLevelExtra: { pinned: true },
  models: [
    {
      id: 'm_1',
      name: 'Writer',
      contextWindow: 200000,
      maxTokens: 8192,
      vision: true,
      extraModelKey: 'kept',
      suppliers: [
        {
          id: 's_1',
          label: 'Primary',
          api: 'openai-completions',
          baseURL: 'https://api.primary.dev/v1/',
          headers: { 'X-Title': 'dsh' },
          model: 'writer-large',
          apiKey: 'env:PRIMARY_KEY',
          enabled: true,
        },
        {
          id: 's_2',
          label: 'Backup',
          api: 'anthropic-messages',
          baseURL: 'https://api.backup.dev',
          model: 'writer-small',
          apiKey: 'sk-backup',
          enabled: false,
        },
      ],
    },
  ],
};

function baseDraft() {
  return {
    version: 1,
    models: [
      {
        id: 'm_1',
        name: 'Writer',
        contextWindow: '128000',
        maxTokens: '8192',
        vision: false,
        suppliers: [
          {
            id: 's_1',
            label: 'Primary',
            api: 'openai-completions',
            baseURL: 'https://api.primary.dev/v1',
            model: 'writer-large',
            apiKey: '',
            headersText: '',
            enabled: true,
          },
        ],
      },
    ],
  };
}

function fakeForm(text) {
  const listeners = new Set();
  const form = {
    status: 'ready',
    writable: true,
    value: { state: typeof text === 'string' ? text : '' },
    sets: [],
    mode: 'accept',
    getSnapshot() {
      return { status: form.status, writable: form.writable, value: form.value };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async set(field, next) {
      form.sets.push({ field, text: next });
      if (form.mode === 'throw') throw new Error('settings RPC socket closed');
      if (form.mode === 'reject') return false;
      form.value = { state: next };
      return true;
    },
    host(next) {
      form.value = { state: next };
      for (const listener of Array.from(listeners)) listener();
    },
    listenerCount() {
      return listeners.size;
    },
  };
  return form;
}

function keysOf(errors) {
  return errors.map(item => item.path + ':' + item.key).sort();
}

function fillFirstModel(ctl) {
  if (ctl.store.getSnapshot().draft.models.length === 0) ctl.addModel();
  ctl.updateModelField(0, 'name', 'Writer');
  ctl.updateSupplierField(0, 0, 'label', 'Primary');
  ctl.updateSupplierField(0, 0, 'baseURL', 'https://api.primary.dev/v1/');
  ctl.updateSupplierField(0, 0, 'model', 'writer-large');
  ctl.updateSupplierField(0, 0, 'apiKey', 'env:PRIMARY_KEY');
  ctl.updateSupplierField(0, 0, 'headersText', 'X-Title: dsh');
}

/* ------------------------------------------------------------------- fake DOM */

function createFakeReact() {
  const slots = [];
  let cursor = 0;
  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children
          .flat(Infinity)
          .filter(child => child !== null && child !== undefined && child !== false && child !== true),
      };
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (index >= slots.length) slots.push(typeof initial === 'function' ? initial() : initial);
      return [
        slots[index],
        next => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        },
      ];
    },
    useEffect(fn) {
      return fn();
    },
    useMemo(factory) {
      return factory();
    },
    useCallback(fn) {
      return fn;
    },
    useRef(value) {
      return { current: value };
    },
    Fragment: 'fragment',
    reset() {
      cursor = 0;
    },
  };
  return React;
}

function toTree(node) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) };
  if (Array.isArray(node)) return { children: node.map(toTree).filter(Boolean) };
  if (typeof node.type === 'function') {
    return toTree(node.type(Object.assign({}, node.props, { children: node.children })));
  }
  return {
    type: node.type,
    props: node.props || {},
    children: node.children.map(toTree).filter(Boolean),
  };
}

function renderSection(React, Section, props) {
  React.reset();
  return toTree(Section(Object.assign({ surfaceId: 'aihub-settings' }, props || {})));
}

function walk(node, out) {
  const all = out || [];
  if (!node) return all;
  all.push(node);
  for (const child of node.children || []) walk(child, all);
  return all;
}

function textOf(node) {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return (node.children || []).map(textOf).join(' ');
}

function byClass(tree, needle) {
  return walk(tree).filter(node => node.props && typeof node.props.className === 'string' && node.props.className.split(/\s+/).indexOf(needle) >= 0);
}

function classList(tree) {
  const names = [];
  for (const node of walk(tree)) {
    const cls = node.props && typeof node.props.className === 'string' ? node.props.className : '';
    if (cls !== '') names.push(cls.split(' ')[0]);
  }
  return names.join(',');
}

function inputsOf(tree, type) {
  return walk(tree).filter(node => node.type === 'input' && node.props.type === type);
}

function textareasOf(tree) {
  return walk(tree).filter(node => node.type === 'textarea');
}

function buttonWith(tree, label) {
  return walk(tree).filter(node => node.type === 'button').filter(node => textOf(node).indexOf(label) >= 0)[0];
}

function createFakeContext(form, remote) {
  const state = { effects: [], disposers: [], registered: [], injected: [], locale: [], dicts: {} };
  const ctx = {
    effect(fn) {
      state.effects.push(fn);
      const disposer = fn();
      if (typeof disposer === 'function') state.disposers.push(disposer);
      return disposer;
    },
    locale: {
      register(ns, first, second) {
        state.locale.push({ ns, first: first === undefined ? null : first, second: second === undefined ? null : second });
        if (first && typeof first === 'object' && second === undefined) {
          Object.assign(state.dicts, first.zh || {});
          Object.assign(state.dicts, first.en || {});
        } else if (typeof first === 'string' && second && typeof second === 'object') {
          Object.assign(state.dicts, second);
        }
      },
      bind() {
        return key => (state.dicts[key] === undefined ? key : state.dicts[key]);
      },
    },
    configForms: {
      get(id) {
        return id === 'aihub' ? form : undefined;
      },
    },
    inject(deps, fn) {
      state.injected.push(deps);
      if (typeof fn === 'function') fn({ remote });
    },
    slots: {
      inject(name, fn) {
        state.injected.push(name);
        return typeof fn === 'function' ? fn() : undefined;
      },
      register(desc, component) {
        state.registered.push({ desc, component });
        return () => {};
      },
    },
  };
  return { ctx, state };
}

function createFakeDocument() {
  const head = {
    children: [],
    appendChild(node) {
      node.parentNode = head;
      head.children.push(node);
      return node;
    },
    removeChild(node) {
      const at = head.children.indexOf(node);
      if (at >= 0) head.children.splice(at, 1);
      node.parentNode = null;
      return node;
    },
  };
  return {
    head,
    createElement(tag) {
      return {
        tagName: tag,
        attributes: {},
        textContent: '',
        parentNode: null,
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      };
    },
  };
}

/* ------------------------------------------------------- dictionaries and CSS */

await check('dictionaries carry the same keys', () => {
  const en = Object.keys(EN).sort();
  const zh = Object.keys(ZH).sort();
  assert.deepEqual(zh, en);
  assert.ok(en.length >= 40, 'expected a full copy set, got ' + en.length);
});

await check('every copy value is a non-empty string', () => {
  for (const dict of [EN, ZH]) {
    for (const key of Object.keys(dict)) {
      assert.equal(typeof dict[key], 'string', key + ' must be a string');
      assert.ok(dict[key].length > 0, key + ' must not be empty');
    }
  }
});

await check('Chinese copy is translated, not copied', () => {
  const keys = Object.keys(EN);
  const translated = keys.filter(key => ZH[key] !== EN[key]).length;
  assert.ok(translated / keys.length > 0.5, 'only ' + translated + ' of ' + keys.length + ' keys differ');
});

await check('every t() key used by the view exists in both dictionaries', () => {
  const used = new Set();
  for (const match of viewSrc.matchAll(/t\('([A-Za-z][A-Za-z0-9_]*)'/g)) used.add(match[1]);
  for (const match of viewSrc.matchAll(/t\("([A-Za-z][A-Za-z0-9_]*)"/g)) used.add(match[1]);
  assert.ok(used.size >= 25, 'expected the view to use at least 25 keys, found ' + used.size);
  for (const key of used) {
    assert.ok(EN[key] !== undefined, 'missing English copy for ' + key);
    assert.ok(ZH[key] !== undefined, 'missing Chinese copy for ' + key);
  }
});

await check('every validation key has copy in both dictionaries', () => {
  const keys = ['errModels', 'errModelId', 'errModelIdDuplicate', 'errModelName', 'errContextWindow', 'errMaxTokens', 'errNoSupplier', 'errNoEnabled', 'errSupplierId', 'errSupplierLabel', 'errApi', 'errBaseURL', 'errSupplierModel', 'errApiKeyEnv', 'errHeaders'];
  for (const key of keys) {
    assert.ok(EN[key] !== undefined, 'missing English copy for ' + key);
    assert.ok(ZH[key] !== undefined, 'missing Chinese copy for ' + key);
  }
});

await check('interpolate fills placeholders once', () => {
  assert.equal(view.interpolate('Model {n}', { n: 1 }), 'Model 1');
  assert.equal(view.interpolate('{a}-{b}', { a: 'x', b: 'y' }), 'x-y');
  assert.equal(view.interpolate('free text', {}), 'free text');
});

await check('stylesheet uses theme tokens only', () => {
  const css = view.AIHUB_CSS;
  assert.ok(css.length > 3000, 'stylesheet looks truncated: ' + css.length + ' chars');
  assert.ok(!/gradient/i.test(css), 'no gradients allowed');
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(css), 'no raw hex colors allowed');
  assert.ok(!/\brgb[a]?\(/.test(css), 'no rgb()/rgba() colors allowed');
  assert.ok(!/\bhsla?\(/.test(css), 'no hsl()/hsla() colors allowed');
  assert.ok(!css.includes('!important'), 'no !important');
  const declared = new Set();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) declared.add(match[1]);
  const used = new Set();
  for (const match of css.matchAll(/var\((--[a-z0-9-]+)/gi)) used.add(match[1]);
  for (const name of used) {
    const themed = name.indexOf('--dsw-') === 0 || name.indexOf('--ds-') === 0;
    const local = name.indexOf('--aihub-') === 0 && declared.has(name);
    assert.ok(themed || local, 'var(' + name + ') is neither a DSH token nor a declared local variable');
  }
  assert.ok(css.includes(':focus-visible'), 'focus must be visible');
  assert.ok(css.includes('@container'), 'narrow screens need a container query');
  assert.ok(css.includes('560px'), 'the 560px breakpoint is missing');
  assert.ok(css.indexOf('border-radius') >= 0, 'cards need a radius token');
});

/* -------------------------------------------------------------- draft rules */

await check('empty hub validates', () => {
  assert.deepEqual(keysOf(controller.validateDraft(controller.emptyDraft())), []);
});

await check('validation rules match the Host gate', () => {
  const cases = [
    ['model id', draft => { draft.models[0].id = 'bad id'; }, ['models.0.id:errModelId']],
    ['duplicate model id', draft => { draft.models.push(JSON.parse(JSON.stringify(draft.models[0]))); }, ['models.1.id:errModelIdDuplicate']],
    ['model name', draft => { draft.models[0].name = '   '; }, ['models.0.name:errModelName']],
    ['context window', draft => { draft.models[0].contextWindow = '999'; }, ['models.0.contextWindow:errContextWindow']],
    ['max tokens', draft => { draft.models[0].maxTokens = '0'; }, ['models.0.maxTokens:errMaxTokens']],
    ['no supplier', draft => { draft.models[0].suppliers = []; }, ['models.0.suppliers:errNoSupplier']],
    ['no enabled supplier', draft => { draft.models[0].suppliers[0].enabled = false; }, ['models.0.suppliers:errNoEnabled']],
    ['supplier id', draft => { draft.models[0].suppliers[0].id = 'bad id'; }, ['models.0.suppliers.0.id:errSupplierId']],
    ['supplier label', draft => { draft.models[0].suppliers[0].label = 'x'.repeat(controller.LIMITS.label + 1); }, ['models.0.suppliers.0.label:errSupplierLabel']],
    ['protocol', draft => { draft.models[0].suppliers[0].api = 'gemini'; }, ['models.0.suppliers.0.api:errApi']],
    ['base URL', draft => { draft.models[0].suppliers[0].baseURL = 'ftp://nope.dev'; }, ['models.0.suppliers.0.baseURL:errBaseURL']],
    ['supplier model id', draft => { draft.models[0].suppliers[0].model = ' '; }, ['models.0.suppliers.0.model:errSupplierModel']],
    ['api key env name', draft => { draft.models[0].suppliers[0].apiKey = 'env:1BAD-NAME'; }, ['models.0.suppliers.0.apiKey:errApiKeyEnv']],
    ['headers text', draft => { draft.models[0].suppliers[0].headersText = 'not a header line'; }, ['models.0.suppliers.0.headers:errHeaders']],
  ];
  for (const [label, mutate, expected] of cases) {
    const draft = baseDraft();
    mutate(draft);
    assert.deepEqual(keysOf(controller.validateDraft(draft)), expected, label);
  }
});

await check('a fresh model row is invalid until it is filled in', () => {
  const found = keysOf(controller.validateDraft({ version: 1, models: [controller.createModelDraft([])] }));
  assert.ok(found.indexOf('models.0.name:errModelName') >= 0, 'name error missing: ' + found.join(','));
  assert.ok(found.indexOf('models.0.suppliers.0.baseURL:errBaseURL') >= 0, 'base URL error missing: ' + found.join(','));
  assert.ok(found.indexOf('models.0.suppliers.0.model:errSupplierModel') >= 0, 'model id error missing: ' + found.join(','));
});

await check('stored document round-trips through the draft', () => {
  const text = JSON.stringify(VALID_DOC);
  const parsed = controller.parseSavedText(text);
  assert.equal(parsed.corrupt, false);
  const draft = parsed.draft;
  assert.equal(draft.models[0].contextWindow, '200000');
  assert.equal(draft.models[0].suppliers[0].baseURL, 'https://api.primary.dev/v1');
  assert.equal(draft.models[0].suppliers[0].headersText, 'X-Title: dsh');
  assert.deepEqual(keysOf(controller.validateDraft(draft)), []);
  const payload = controller.toPayload(draft);
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.topLevelExtra, { pinned: true });
  assert.equal(payload.models[0].extraModelKey, 'kept');
  assert.equal(payload.models[0].contextWindow, 200000);
  assert.equal(payload.models[0].maxTokens, 8192);
  assert.deepEqual(payload.models[0].suppliers[0].headers, { 'X-Title': 'dsh' });
  assert.equal(payload.models[0].suppliers[0].apiKey, 'env:PRIMARY_KEY');
  assert.equal(payload.models[0].suppliers[1].enabled, false);
  assert.equal(payload.models[1], undefined);
});

await check('unreadable stored text is reported, not thrown', () => {
  assert.deepEqual(controller.parseSavedText('').corrupt, false);
  assert.deepEqual(controller.parseSavedText('').draft, { version: 1, models: [] });
  assert.equal(controller.parseSavedText('{oops').corrupt, true);
  assert.equal(controller.parseSavedText('[]').corrupt, true);
  assert.equal(controller.parseSavedText(JSON.stringify({ version: 2, models: [] })).corrupt, true);
});

/* --------------------------------------------------------------- controller */

await check('controller: edit, gate, save, echo, discard', async () => {
  const form = fakeForm(JSON.stringify({ version: 1, models: [] }));
  const ctl = controller.createAihubController(form);
  let snap = ctl.store.getSnapshot();
  assert.equal(snap.status, 'ready');
  assert.equal(snap.writable, true);
  assert.equal(snap.dirty, false);
  assert.equal(snap.draft.models.length, 0);

  const seen = [];
  const off = ctl.store.subscribe(() => seen.push(ctl.store.getSnapshot().dirty));
  ctl.addModel();
  assert.ok(seen.length > 0, 'subscribers must be notified');
  off();

  snap = ctl.store.getSnapshot();
  assert.equal(snap.dirty, true);
  const before = form.sets.length;
  assert.equal(await ctl.save(), false);
  assert.equal(form.sets.length, before, 'the client gate must not write the Host');
  snap = ctl.store.getSnapshot();
  assert.equal(snap.notice, 'invalid');
  assert.equal(snap.attempted, true);
  assert.ok(snap.errors.length >= 3, 'expected row errors, got ' + snap.errors.length);

  fillFirstModel(ctl);
  assert.deepEqual(keysOf(controller.validateDraft(ctl.store.getSnapshot().draft)), []);
  assert.equal(await ctl.save(), true);
  assert.equal(form.sets.length, 1);
  assert.equal(form.sets[0].field, 'state');
  const written = JSON.parse(form.sets[0].text);
  assert.equal(written.version, 1);
  assert.equal(written.models[0].name, 'Writer');
  assert.equal(written.models[0].contextWindow, 128000);
  assert.equal(typeof written.models[0].contextWindow, 'number');
  assert.equal(written.models[0].suppliers[0].baseURL, 'https://api.primary.dev/v1');
  assert.deepEqual(written.models[0].suppliers[0].headers, { 'X-Title': 'dsh' });
  assert.equal(written.models[0].suppliers[0].apiKey, 'env:PRIMARY_KEY');
  snap = ctl.store.getSnapshot();
  assert.equal(snap.notice, 'saved');
  assert.equal(snap.dirty, false);

  form.host(JSON.stringify(written));
  snap = ctl.store.getSnapshot();
  assert.equal(snap.draft.models[0].name, 'Writer');
  assert.equal(snap.dirty, false);

  ctl.updateModelField(0, 'name', 'Writer 2');
  form.host(JSON.stringify(written));
  snap = ctl.store.getSnapshot();
  assert.equal(snap.draft.models[0].name, 'Writer 2', 'a host echo must not overwrite unsaved edits');
  assert.equal(snap.dirty, true);

  ctl.discard();
  snap = ctl.store.getSnapshot();
  assert.equal(snap.dirty, false);
  assert.equal(snap.draft.models[0].name, 'Writer');
  ctl.dispose();
});

await check('controller: supplier order and removal', () => {
  const form = fakeForm(JSON.stringify(VALID_DOC));
  const ctl = controller.createAihubController(form);
  ctl.moveSupplier(0, 1, -1);
  let snap = ctl.store.getSnapshot();
  assert.deepEqual(snap.draft.models[0].suppliers.map(row => row.id), ['s_2', 's_1']);
  ctl.moveSupplier(0, 0, -1);
  snap = ctl.store.getSnapshot();
  assert.deepEqual(snap.draft.models[0].suppliers.map(row => row.id), ['s_2', 's_1']);
  ctl.addSupplier(0);
  snap = ctl.store.getSnapshot();
  assert.equal(snap.draft.models[0].suppliers.length, 3);
  ctl.removeSupplier(0, 2);
  ctl.removeModel(0);
  snap = ctl.store.getSnapshot();
  assert.equal(snap.draft.models.length, 0);
  assert.equal(snap.dirty, true);
  ctl.dispose();
});

await check('controller: refused save keeps the draft and shows the reason', async () => {
  const form = fakeForm(JSON.stringify({ version: 1, models: [] }));
  form.mode = 'reject';
  const ctl = controller.createAihubController(form, { probe: async () => ({ ok: false, reason: 'aihub revision 3 is stale' }) });
  fillFirstModel(ctl);
  assert.equal(await ctl.save(), false);
  const snap = ctl.store.getSnapshot();
  assert.equal(snap.notice, 'rejected');
  assert.equal(snap.reason, 'aihub revision 3 is stale');
  assert.equal(snap.dirty, true);
  assert.equal(snap.saving, false);
  ctl.dispose();
});

await check('controller: a probe that succeeds marks the draft saved', async () => {
  const form = fakeForm(JSON.stringify({ version: 1, models: [] }));
  form.mode = 'reject';
  const ctl = controller.createAihubController(form, { probe: async () => ({ ok: true, reason: '' }) });
  fillFirstModel(ctl);
  assert.equal(await ctl.save(), true);
  const snap = ctl.store.getSnapshot();
  assert.equal(snap.notice, 'saved');
  assert.equal(snap.dirty, false);
  ctl.dispose();
});

await check('controller: a throwing form is a failure, not a crash', async () => {
  const form = fakeForm(JSON.stringify({ version: 1, models: [] }));
  form.mode = 'throw';
  const ctl = controller.createAihubController(form);
  fillFirstModel(ctl);
  assert.equal(await ctl.save(), false);
  const snap = ctl.store.getSnapshot();
  assert.equal(snap.notice, 'failed');
  assert.ok(snap.reason.indexOf('socket closed') >= 0, 'reason lost: ' + snap.reason);
  assert.equal(snap.saving, false);
  ctl.dispose();
});

await check('controller: unavailable form is read-only and never saves', async () => {
  const ctl = controller.createAihubController(null);
  const snap = ctl.store.getSnapshot();
  assert.equal(snap.status, 'unavailable');
  assert.equal(snap.writable, false);
  assert.equal(await ctl.save(), false);
  ctl.dispose();

  const form = fakeForm(JSON.stringify({ version: 1, models: [] }));
  form.writable = false;
  const locked = controller.createAihubController(form);
  assert.equal(locked.store.getSnapshot().writable, false);
  assert.equal(await locked.save(), false);
  assert.equal(form.sets.length, 0);
  locked.dispose();
});

await check('controller: corrupt stored text is surfaced', () => {
  const ctl = controller.createAihubController(fakeForm('{oops'));
  const snap = ctl.store.getSnapshot();
  assert.equal(snap.corrupt, true);
  assert.equal(snap.status, 'ready');
  assert.equal(snap.draft.models.length, 0);
  ctl.dispose();
});

await check('controller: odd snapshot payloads never break the draft', () => {
  const payloads = [undefined, {}, { state: '' }, { state: null }, { state: { version: 1, models: [] } }, { state: 'null' }, { state: '[]' }];
  for (const value of payloads) {
    const form = fakeForm('');
    form.getSnapshot = () => ({ status: 'ready', writable: true, value });
    const ctl = controller.createAihubController(form);
    const snap = ctl.store.getSnapshot();
    assert.equal(snap.status, 'ready');
    assert.equal(snap.draft.models.length, 0);
    assert.equal(snap.writable, true);
    ctl.dispose();
  }
});

await check('controller: a double click cannot write twice', async () => {
  const form = fakeForm(JSON.stringify({ version: 1, models: [] }));
  const ctl = controller.createAihubController(form);
  fillFirstModel(ctl);
  const first = ctl.save();
  const second = ctl.save();
  assert.equal(await second, false, 'the second save must be ignored while one is running');
  assert.equal(await first, true);
  assert.equal(form.sets.length, 1, 'only one write may reach the Host');
  ctl.dispose();
});
/* ------------------------------------------------------------- built bundle */

const bundleSrc = await read('client/client.js');

await check('bundle keeps the lazy factory ABI', () => {
  assert.ok(bundleSrc.startsWith('// Generated by'), 'bundle must carry its generated header');
  assert.equal((bundleSrc.match(/__ModuleLoader__\.load\(/g) || []).length, 1, 'exactly one load() call');
  assert.ok(!/^\s*import\s/m.test(bundleSrc), 'no ESM imports allowed in a client bundle');
  assert.ok(!/^\s*export\s/m.test(bundleSrc), 'no ESM exports allowed in a client bundle');
  assert.ok(!bundleSrc.includes('console.'), 'the bundle must not log');
  assert.ok(!bundleSrc.includes('debugger'), 'the bundle must not ship a debugger statement');
  const requires = new Set();
  for (const match of bundleSrc.matchAll(/require\(([^)]+)\)/g)) requires.add(match[1]);
  assert.deepEqual(Array.from(requires), ["'react'"]);
  assert.ok(bundleSrc.length > 20000, 'bundle looks truncated: ' + bundleSrc.length);
});

await check('bundle contains all three sources', () => {
  for (const marker of ['function createAihubController(', 'AihubSection.mount = ', 'function createProbe(ctx)']) {
    assert.ok(bundleSrc.indexOf(marker) >= 0, 'missing ' + marker);
  }
});

await check('bundle evaluates into a plugin that mounts one section', async () => {
  const entries = [];
  const fakeWindow = { __ModuleLoader__: { load(entry) { entries.push(entry); } } };
  const run = new Function('window', bundleSrc);
  run(fakeWindow);
  assert.equal(entries.length, 1);
  const loaded = entries[0];
  assert.equal(loaded.id, 'dsh-aihub');
  assert.equal(typeof loaded.factory, 'function');

  const React = createFakeReact();
  const plugin = loaded.factory(request => {
    assert.equal(request, 'react');
    return React;
  });
  assert.equal(plugin.name, 'dsh-aihub');
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms']);

  const form = fakeForm(JSON.stringify({ version: 1, models: [] }));
  const remote = {
    settings: {
      async describe() {
        return { ok: true, value: { namespaces: [{ ns: 'aihub', revision: 3 }] } };
      },
      async mutate(ns, ops, revision) {
        return { ok: true };
      },
    },
  };
  const built = createFakeContext(form, remote);
  const doc = createFakeDocument();
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    plugin.apply(built.ctx);
  } finally {
    globalThis.document = previous;
  }

  const style = doc.head.children[0];
  assert.ok(style, 'the section stylesheet must be injected');
  assert.equal(style.attributes['data-plugin'], 'dsh-aihub');
  assert.equal(style.textContent, view.AIHUB_CSS);
  assert.equal(form.sets.length, 0, 'mounting must never write the Host');

  const registration = built.state.locale[0];
  assert.equal(registration.ns, 'settings.aihub');
  assert.ok(registration.first && registration.first.en && registration.first.zh, 'both dictionaries must be registered');
  assert.deepEqual(Object.keys(registration.first.zh).sort(), Object.keys(EN).sort());

  assert.equal(built.state.registered.length, 1);
  const desc = built.state.registered[0].desc;
  assert.equal(desc.name, 'settings.section');
  assert.equal(desc.id, 'aihub');
  assert.equal(desc.order, 40);
  assert.equal(desc.locale, 'settings.aihub');
  assert.equal(typeof desc.label, 'function');
  assert.equal(desc.label(), EN.title);

  const props = desc.inject();
  assert.equal(props.surfaceId, 'aihub-settings');
  assert.equal(typeof props.hooks.aihubDraft.getSnapshot, 'function');
  assert.equal(typeof props.hooks.aihubDraft.subscribe, 'function');
  assert.equal(typeof props.reset, 'function');
  assert.ok(built.state.injected.indexOf('settings.section') >= 0, 'the section slot must be injected');
  assert.ok(built.state.injected.some(deps => Array.isArray(deps) && deps.indexOf('remote.settings') >= 0), 'the settings remote must be injected');

  const Section = built.state.registered[0].component;
  const first = renderSection(React, Section, props);
  assert.equal(byClass(first, 'aihub-empty').length, 1, 'an empty hub must show the empty state; classes=' + classList(first) + ' root=' + (first && first.type));
  assert.ok(textOf(first).indexOf(EN.title) >= 0, 'the section title is missing');

  const addButton = buttonWith(first, EN.addModel);
  assert.ok(addButton, 'the New model button is missing');
  addButton.props.onClick({});
  const second = renderSection(React, Section, props);
  assert.ok(byClass(second, 'aihub-model').length === 1, 'a new model card must appear');
  assert.ok(textOf(second).indexOf('Model 1') >= 0, 'the model card is not numbered');

  const saveButton = buttonWith(second, EN.save);
  assert.ok(saveButton, 'the Save button is missing');
  assert.equal(saveButton.props.disabled, false, 'Save must be enabled while the draft is dirty');
  saveButton.props.onClick({});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(form.sets.length, 0, 'a save the client gate refuses must not reach the Host');
  const third = renderSection(React, Section, props);
  const status = byClass(third, 'aihub-status--error')[0];
  assert.ok(status, 'a refused save must show an error status');
  assert.equal(status.props.role, 'alert');
  assert.ok(textOf(status).length > 0, 'the error status needs copy');

  props.reset();
  const fourth = renderSection(React, Section, props);
  assert.equal(byClass(fourth, 'aihub-empty').length, 1, 'reset must restore the saved document; classes=' + classList(fourth));

  for (const disposer of built.state.disposers) {
    if (typeof disposer === 'function') disposer();
  }
});

await check('section renders a saved document and masks API keys', () => {
  const React = createFakeReact();
  const Section = view.createAihubSection(React);
  const form = fakeForm(JSON.stringify(VALID_DOC));
  const ctl = controller.createAihubController(form);
  Section.mount({ controller: ctl, t: key => (EN[key] === undefined ? key : EN[key]) });
  const tree = renderSection(React, Section, {});
  const text = textOf(tree);
  assert.ok(text.indexOf(EN.title) >= 0, 'title missing');
  const named = inputsOf(tree, 'text').filter(node => node.props.value === 'Writer');
  assert.equal(named.length, 1, 'the model name must be editable in a text input, got ' + classList(tree));

  const secrets = inputsOf(tree, 'password');
  assert.equal(secrets.length, 2, 'both API keys must start masked, got ' + secrets.length);
  assert.equal(secrets[0].props.value, 'env:PRIMARY_KEY');
  assert.ok(text.indexOf('env:PRIMARY_KEY') < 0, 'the key must never render as text');

  const headers = textareasOf(tree);
  assert.equal(headers.length, 2);
  assert.equal(headers[0].props.value, 'X-Title: dsh');

  const checkboxes = inputsOf(tree, 'checkbox');
  assert.equal(checkboxes.length, 3, 'vision plus two enabled switches');
  assert.equal(checkboxes[1].props.checked, true);
  assert.equal(checkboxes[2].props.checked, false);

  const reveal = walk(tree).filter(node => node.type === 'button' && node.props['aria-pressed'] === 'false')[0];
  assert.ok(reveal, 'the reveal toggle is missing');
  reveal.props.onClick({});
  const revealedTree = renderSection(React, Section, {});
  const shown = inputsOf(revealedTree, 'text').filter(node => node.props.value === 'env:PRIMARY_KEY');
  assert.equal(shown.length, 1, 'revealing must show the key as text input');
  assert.equal(inputsOf(revealedTree, 'password').length, 1, 'the other key stays masked');
  ctl.dispose();
});

await check('section follows the Host locale service', () => {
  const React = createFakeReact();
  const Section = view.createAihubSection(React);
  const form = fakeForm(JSON.stringify({ version: 1, models: [] }));
  const ctl = controller.createAihubController(form);
  Section.mount({ controller: ctl, t: key => (ZH[key] === undefined ? key : ZH[key]) });
  const tree = renderSection(React, Section, {});
  const text = textOf(tree);
  assert.ok(text.indexOf(ZH.title) >= 0, 'Chinese title missing');
  assert.ok(text.indexOf(ZH.addModel) >= 0, 'Chinese button copy missing');
  assert.ok(text.indexOf(ZH.empty) >= 0, 'Chinese empty state missing');
  ctl.dispose();
});

/* -------------------------------------------------------------------- report */

const failed = results.filter(line => line.indexOf('  FAIL') === 0);
console.log('[check-ui] dsh-aihub client half');
console.log(results.join('\n'));
console.log('');
if (failed.length > 0) {
  console.log('[check-ui] ' + failed.length + ' check(s) failed, ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('[check-ui] all ' + passed + ' checks passed');
}
