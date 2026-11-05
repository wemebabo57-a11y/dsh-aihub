/**
 * dsh-aihub browser half — the settings section.
 *
 * One screen: a header that owns New model / Discard / Save, one block per
 * model with its suppliers listed in fallback order, and the same save bar at
 * the end of long lists. Everything here renders from the draft store in
 * controller.mjs, so the UI never talks to the Host directly and never keeps a
 * second copy of the document.
 *
 * Styling is DSH theme tokens only (--dsw-alias-*), so the section follows the
 * light and dark palettes of the app it is mounted in.
 * @module dsh-aihub/client/view
 */

import { API_CHOICES } from './controller.mjs';

/** English copy. Keys are shared with the Chinese dictionary below. */
export const EN = Object.freeze({
  title: 'AI Hub',
  intro: 'Publish several models that try their suppliers in order. Edit here, then save once.',
  save: 'Save',
  saving: 'Saving...',
  discard: 'Discard',
  addModel: 'New model',
  removeModel: 'Delete model',
  modelN: 'Model {n}',
  nameLabel: 'Display name',
  namePlaceholder: 'e.g. Writing - primary',
  nameHint: 'This is the name the model picker shows under aihub.',
  contextLabel: 'Context window',
  maxLabel: 'Max output',
  visionLabel: 'Accepts images',
  suppliers: 'Suppliers',
  switchHint: 'Tried in this order. When one fails the next one takes over.',
  supplierN: 'Supplier {n}',
  moveUpAria: 'Move {label} up',
  moveDownAria: 'Move {label} down',
  removeSupplierAria: 'Delete {label}',
  addSupplier: 'Add supplier',
  labelLabel: 'Label',
  labelPlaceholder: 'e.g. OpenAI official',
  apiLabel: 'Protocol',
  baseURLLabel: 'Base URL',
  baseURLPlaceholder: 'https://api.openai.com/v1',
  modelIdLabel: 'Model id',
  modelIdPlaceholder: 'e.g. gpt-5',
  apiKeyLabel: 'API key',
  apiKeyHint: 'Stored as plain text in this profile. Use env:NAME to read an environment variable.',
  show: 'Show',
  hide: 'Hide',
  enabledLabel: 'Enabled',
  advancedHeaders: 'Extra headers',
  headersLabel: 'Headers',
  headersHint: 'One per line, written as Name: value.',
  headersPlaceholder: 'X-Tenant: me',
  empty: 'No models yet',
  emptyHint: 'Create a model, name it, add the suppliers that serve it, then save once.',
  dirty: 'Unsaved changes',
  saved: 'Saved. The next request uses it.',
  invalid: '{n} field(s) still need fixing - nothing was saved.',
  rejected: 'The Host refused this save, so the saved settings are unchanged.',
  rejectedWith: 'The Host refused this save: {reason}',
  failed: 'Saving failed before the Host answered. Try again.',
  failedWith: 'Saving failed: {reason}',
  loading: 'Reading saved settings...',
  unavailable: 'This profile does not serve the aihub settings.',
  unavailableHint: 'Check that dsh-aihub is installed and enabled for this profile, then reload the page.',
  readonly: 'This profile is read only. The saved models are shown for reference.',
  corrupt: 'The saved settings could not be read, so this page shows an empty hub. Saving replaces them.',
  footerHint: 'Saving writes the whole document at once and applies to the next request.',
  errModels: 'The model list is malformed.',
  errModelId: 'Use 1-64 letters, digits, dashes or underscores.',
  errModelIdDuplicate: 'The id {id} is already used by another model.',
  errModelName: 'A display name of 1-{max} characters is required.',
  errContextWindow: 'Use a whole number from {min} to {max}.',
  errMaxTokens: 'Use a whole number from {min} to {max}.',
  errNoSupplier: 'Add at least one supplier.',
  errNoEnabled: 'Keep at least one supplier enabled.',
  errSupplierId: 'This supplier id is not usable.',
  errSupplierLabel: 'Keep the label within {max} characters.',
  errApi: 'Pick one of the two protocols.',
  errBaseURL: 'Base URL must be an http or https address.',
  errSupplierModel: 'The model id is required.',
  errApiKeyEnv: 'Write a valid variable name after env:.',
  errHeaders: 'Each line must read Name: value.',
});

/** Chinese copy, same keys as EN. */
export const ZH = Object.freeze({
  title: 'AI Hub',
  intro: '把多个供应方聚合成一个模型：按顺序尝试，接不上就自动切换。改完一次保存。',
  save: '保存',
  saving: '正在保存...',
  discard: '还原',
  addModel: '新建模型',
  removeModel: '删除模型',
  modelN: '模型 {n}',
  nameLabel: '显示名称',
  namePlaceholder: '例如：写作 · 主力',
  nameHint: '模型选择器里 aihub 下显示的就是这个名字。',
  contextLabel: '上下文窗口',
  maxLabel: '输出上限',
  visionLabel: '支持图片输入',
  suppliers: '供应方',
  switchHint: '顺序即切换顺序，前一个接不上就换下一个。',
  supplierN: '供应方 {n}',
  moveUpAria: '上移 {label}',
  moveDownAria: '下移 {label}',
  removeSupplierAria: '删除 {label}',
  addSupplier: '添加供应方',
  labelLabel: '标签',
  labelPlaceholder: '例如：OpenAI 官方',
  apiLabel: '协议',
  baseURLLabel: 'Base URL',
  baseURLPlaceholder: 'https://api.openai.com/v1',
  modelIdLabel: '模型 id',
  modelIdPlaceholder: '例如：gpt-5',
  apiKeyLabel: 'API Key',
  apiKeyHint: '以明文保存在当前配置中；可填 env:变量名 读取环境变量。',
  show: '显示',
  hide: '隐藏',
  enabledLabel: '启用',
  advancedHeaders: '额外请求头',
  headersLabel: '请求头',
  headersHint: '每行一个，写成「名称: 值」。',
  headersPlaceholder: 'X-Tenant: me',
  empty: '还没有模型',
  emptyHint: '新建一个模型，填好显示名，加入为它服务的供应方，然后保存一次。',
  dirty: '有未保存的修改',
  saved: '已保存，下一次请求即使用新配置。',
  invalid: '还有 {n} 处需要修正，这次没有保存。',
  rejected: '宿主拒绝了这次保存，已保存的配置没有改变。',
  rejectedWith: '宿主拒绝了这次保存：{reason}',
  failed: '还没得到宿主答复就失败了，请重试。',
  failedWith: '保存失败：{reason}',
  loading: '正在读取已保存的设置...',
  unavailable: '当前配置没有提供 aihub 设置。',
  unavailableHint: '请确认 dsh-aihub 已安装并在当前配置中启用，然后重新加载页面。',
  readonly: '当前配置是只读的，下面显示已保存的模型。',
  corrupt: '已保存的设置无法读取，这里按空配置显示；保存会覆盖它。',
  footerHint: '保存会一次写入整个文档，下一次请求即生效。',
  errModels: '模型列表格式不正确。',
  errModelId: 'id 只能用字母、数字、连字符或下划线，长度 1-64。',
  errModelIdDuplicate: 'id {id} 与其他模型重复。',
  errModelName: '显示名称需为 1-{max} 个字符。',
  errContextWindow: '需为 {min}-{max} 的整数。',
  errMaxTokens: '需为 {min}-{max} 的整数。',
  errNoSupplier: '至少需要一个供应方。',
  errNoEnabled: '至少要保留一个启用的供应方。',
  errSupplierId: '供应方内部 id 不可用。',
  errSupplierLabel: '标签不能超过 {max} 个字符。',
  errApi: '协议只能选这两项之一。',
  errBaseURL: 'Base URL 需为 http 或 https 地址。',
  errSupplierModel: '模型 id 不能为空。',
  errApiKeyEnv: 'env: 后需为有效的环境变量名。',
  errHeaders: '每行需写成「名称: 值」。',
});

/** Fill {name} placeholders; used for both dictionaries and Host messages. */
export function interpolate(text, vars) {
  let out = typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text);
  if (!vars || typeof vars !== 'object') return out;
  for (const key of Object.keys(vars)) {
    out = out.split('{' + key + '}').join(String(vars[key]));
  }
  return out;
}

const EMPTY_SNAPSHOT = Object.freeze({
  status: 'loading',
  writable: false,
  draft: Object.freeze({ version: 1, models: Object.freeze([]) }),
  dirty: false,
  saving: false,
  attempted: false,
  notice: '',
  reason: '',
  corrupt: false,
  errors: Object.freeze([]),
  errorMap: Object.freeze({}),
  touched: Object.freeze([]),
});

const EMPTY_STORE = Object.freeze({
  getSnapshot: () => EMPTY_SNAPSHOT,
  subscribe: () => () => {},
});

/** Section styles: theme tokens only, no gradients, no per-block card stacking. */
export const AIHUB_CSS = `

.aihub{
  --aihub-line-2:var(--dsw-alias-border-l2);
  --aihub-line-3:var(--dsw-alias-border-l3);
  --aihub-line-4:var(--dsw-alias-border-l4);
  --aihub-text:var(--dsw-alias-label-primary);
  --aihub-secondary:var(--dsw-alias-label-secondary);
  --aihub-muted:var(--dsw-alias-label-tertiary);
  --aihub-dimmed:var(--dsw-alias-label-dimmed);
  --aihub-accent:var(--dsw-alias-state-business-primary);
  --aihub-danger:var(--dsw-alias-state-error-primary);
  --aihub-ok:var(--dsw-alias-state-success-primary);
  --aihub-warn:var(--dsw-alias-state-warn-primary);
  --aihub-card-fill:var(--dsw-alias-settings-card-fill);
  --aihub-card-stroke:var(--dsw-alias-settings-card-stroke);
  --aihub-field-bg:var(--dsw-alias-bg-layer-1);
  box-sizing:border-box;
  display:flex;
  flex-direction:column;
  gap:12px;
  max-width:760px;
  padding:8px 0 28px;
  color:var(--aihub-text);
  font:inherit;
  container:aihub-main/inline-size;
}
.aihub *,.aihub *::before,.aihub *::after{box-sizing:border-box}
.aihub h2,.aihub h3,.aihub h4,.aihub p,.aihub ol,.aihub li{margin:0;padding:0}
.aihub h2{font-size:16px;font-weight:500;line-height:24px}
.aihub h3{font-size:14px;font-weight:500;line-height:22px}
.aihub h4{font-size:12px;font-weight:500;line-height:18px;color:var(--aihub-secondary);letter-spacing:0}
.aihub ol{list-style:none}
.aihub__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px 16px;flex-wrap:wrap}
.aihub__headText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 280px}
.aihub__intro{color:var(--aihub-secondary);font-size:14px;line-height:22px}
.aihub__hint{color:var(--aihub-muted);font-size:12px;line-height:18px}
.aihub__toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.aihub-status{min-height:18px;font-size:12px;line-height:18px;color:var(--aihub-muted)}
.aihub-status--ok{color:var(--aihub-ok)}
.aihub-status--warn{color:var(--aihub-warn)}
.aihub-status--error{color:var(--aihub-danger)}
.aihub-btn{
  box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:36px;padding:0 14px;font:inherit;font-size:14px;line-height:22px;
  color:var(--aihub-text);background:0 0;border:0.5px solid var(--aihub-line-3);
  border-radius:var(--dsw-radius-md);cursor:pointer;white-space:nowrap;
}
.aihub-btn--primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.aihub-btn--sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm)}
.aihub-btn--icon{width:28px;height:28px;padding:0;border-radius:var(--dsw-radius-sm);color:var(--aihub-secondary);border-color:transparent}
.aihub-btn--danger{color:var(--aihub-danger);border-color:transparent}
.aihub-btn--dashed{width:100%;justify-content:flex-start;height:32px;padding:0 12px;font-size:13px;border-style:dashed;color:var(--aihub-secondary)}
.aihub-btn:disabled{opacity:0.4;cursor:default}
.aihub-btn:focus-visible,.aihub-input:focus-visible,.aihub-sup__more summary:focus-visible,.aihub-check input:focus-visible{
  outline:2px solid var(--dsw-focus-ring-color,var(--aihub-accent));outline-offset:2px;
}
@media (hover:hover){
  .aihub-btn:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}
  .aihub-btn--primary:not(:disabled):hover{background:var(--dsw-alias-button-primary-hover)}
  .aihub-btn--danger:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
  .aihub-btn--icon:not(:disabled):hover{color:var(--aihub-text);background:var(--dsw-alias-interactive-bg-hover)}
}
.aihub-input{
  box-sizing:border-box;width:100%;height:32px;padding:0 10px;
  font:inherit;font-size:14px;line-height:22px;color:var(--aihub-text);
  background:var(--aihub-field-bg);border:0.5px solid var(--aihub-line-4);
  border-radius:var(--dsw-radius-md);
}
.aihub-input::placeholder{color:var(--aihub-dimmed)}
.aihub-input:focus{border-color:var(--aihub-accent);outline:none}
.aihub-input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--aihub-accent));outline-offset:1px}
.aihub-input[aria-invalid="true"]{border-color:var(--aihub-danger)}
.aihub-input:disabled{opacity:0.6;cursor:default}
select.aihub-input{cursor:pointer;padding-right:8px}
textarea.aihub-input{height:auto;min-height:56px;padding:6px 10px;resize:vertical;line-height:20px}
.aihub-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.aihub-field__label{color:var(--aihub-muted);font-size:12px;line-height:18px}
.aihub-field__hint{color:var(--aihub-muted);font-size:12px;line-height:18px}
.aihub-field--wide{min-width:0}
.aihub-err{color:var(--aihub-danger);font-size:12px;line-height:18px}
.aihub-check{display:inline-flex;align-items:center;gap:6px;min-height:32px;font-size:12px;line-height:18px;color:var(--aihub-secondary);cursor:pointer}
.aihub-check input{width:16px;height:16px;margin:0;accent-color:var(--aihub-accent);cursor:pointer}
.aihub__models{display:flex;flex-direction:column;gap:12px}
.aihub-model{
  display:flex;flex-direction:column;gap:12px;
  padding:12px 14px;border:0.5px solid var(--aihub-card-stroke);
  background:var(--aihub-card-fill);border-radius:var(--dsw-radius-xl);
}
.aihub-model__head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.aihub-model__identity{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}
.aihub-model__id{
  font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;color:var(--aihub-muted);
  padding:0 5px;border:0.5px solid var(--aihub-line-2);border-radius:var(--dsw-radius-xs);
}
.aihub-model__fields{display:grid;grid-template-columns:minmax(0,1fr) 132px 118px;gap:8px 12px;align-items:start}
.aihub-model__vision{display:flex}
.aihub-model__suppliers{display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:0.5px solid var(--aihub-line-2)}
.aihub-model__suppliersHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}
.aihub-suppliers{display:flex;flex-direction:column;min-width:0}
.aihub-sup{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 0;border-top:0.5px solid var(--aihub-line-2)}
.aihub-sup:first-child{border-top:0;padding-top:0}
.aihub-sup__head{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
.aihub-sup__index{font-size:11px;line-height:32px;color:var(--aihub-muted);font-variant-numeric:tabular-nums;min-width:18px}
.aihub-sup__index+.aihub-field{flex:1 1 150px}
.aihub-sup__api{flex:0 0 170px}
.aihub-sup__actions{display:flex;align-items:center;gap:2px;margin-left:auto}
.aihub-sup__grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) minmax(0,1.2fr);gap:8px 12px;align-items:start}
.aihub-key{display:flex;align-items:center;gap:6px;min-width:0}
.aihub-key .aihub-input{flex:1 1 auto;min-width:0}
.aihub-key .aihub-btn{flex:none}
.aihub-sup__more{font-size:12px;line-height:18px}
.aihub-sup__more summary{cursor:pointer;color:var(--aihub-secondary);padding:2px 0;border-radius:var(--dsw-radius-xs);width:max-content}
.aihub-sup__more[open] summary{color:var(--aihub-text)}
.aihub-sup__moreBody{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.aihub-empty{
  display:flex;flex-direction:column;align-items:flex-start;gap:8px;
  padding:16px;border:1px dashed var(--aihub-line-3);border-radius:var(--dsw-radius-lg);
}
.aihub-empty__title{font-size:14px;line-height:22px;font-weight:500}
.aihub__footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:12px;border-top:0.5px solid var(--aihub-line-2)}
.aihub__footer .aihub__toolbar{flex:none}
@container aihub-main (width<=560px){
  .aihub-model__fields{grid-template-columns:minmax(0,1fr)}
  .aihub-sup__grid{grid-template-columns:minmax(0,1fr)}
  .aihub-sup__api{flex:1 1 140px}
  .aihub-sup__actions{margin-left:0}
  .aihub__footer{flex-direction:column;align-items:stretch}
  .aihub__footer .aihub__toolbar{justify-content:flex-end}
}
@media (width<=560px){
  .aihub-model__fields{grid-template-columns:minmax(0,1fr)}
  .aihub-sup__grid{grid-template-columns:minmax(0,1fr)}
  .aihub__footer{flex-direction:column;align-items:stretch}
}

`;
;

/**
 * Build the settings section component.
 * @param React - the Host's React instance, the only dependency of this bundle.
 */
export function createAihubSection(React) {
  const h = React.createElement;
  let session = null;

  function useSnapshot(store) {
    const initial = store.getSnapshot();
    const state = React.useState(initial);
    const snapshot = state[0];
    const setSnapshot = state[1];
    React.useEffect(() => {
      let live = true;
      const sync = () => {
        if (live) setSnapshot(store.getSnapshot());
      };
      sync();
      const off = store.subscribe(sync);
      return () => {
        live = false;
        if (typeof off === 'function') off();
      };
    }, [store]);
    return snapshot;
  }

  function AihubSection(props) {
    const settings = props && typeof props === 'object' ? props : {};
    const surfaceId = typeof settings.surfaceId === 'string' && settings.surfaceId !== '' ? settings.surfaceId : 'aihub-settings';
    const mounted = session && typeof session.t === 'function' ? session.t : null;
    const t = typeof settings.t === 'function' ? settings.t : mounted || function fallback(key, vars) {
      return interpolate(EN[key] === undefined ? key : EN[key], vars);
    };
    const controller = session && session.controller ? session.controller : null;
    const store = controller ? controller.store : EMPTY_STORE;
    const snapshot = useSnapshot(store);
    const revealedState = React.useState({});
    const revealed = revealedState[0];
    const setRevealed = revealedState[1];

    const titleId = surfaceId + '-title';
    const canEdit = snapshot.status === 'ready' && snapshot.writable === true;
    const busy = snapshot.saving === true;
    const disabled = canEdit !== true || busy;
    const canSave = canEdit && snapshot.dirty === true && busy !== true;

    const fieldId = path => surfaceId + '-' + String(path).replace(/[^A-Za-z0-9_-]+/g, '-');
    const showsError = path => {
      if (!snapshot.errorMap[path]) return false;
      return snapshot.attempted === true || snapshot.touched.indexOf(path) >= 0;
    };
    const errorNode = path => {
      if (!showsError(path)) return null;
      const entry = snapshot.errorMap[path];
      return h('p', { className: 'aihub-err', id: fieldId(path) + '-err' }, t(entry.key, entry.params));
    };
    const ariaInvalid = path => (showsError(path) ? true : undefined);
    const ariaDescribed = path => (showsError(path) ? fieldId(path) + '-err' : undefined);
    const markTouched = path => {
      if (controller) controller.touch(path);
    };

    function textField(config) {
      const wrongPath = config.errorPath ? config.errorPath : config.path;
      const input = h('input', {
        id: fieldId(config.path),
        className: 'aihub-input',
        type: config.secret ? (config.revealed === true ? 'text' : 'password') : 'text',
        value: config.value === undefined || config.value === null ? '' : config.value,
        placeholder: config.placeholder,
        autoComplete: 'off',
        autoCorrect: 'off',
        spellCheck: false,
        inputMode: config.inputMode,
        disabled: disabled,
        'aria-invalid': ariaInvalid(wrongPath),
        'aria-describedby': ariaDescribed(wrongPath),
        onChange: event => config.onChange(event.currentTarget.value),
        onBlur: () => markTouched(wrongPath),
      });
      const control = config.trailing ? h('div', { className: 'aihub-key' }, input, config.trailing) : input;
      return h('div', { className: 'aihub-field' + (config.className ? ' ' + config.className : '') },
        h('label', { className: 'aihub-field__label', htmlFor: fieldId(config.path) }, config.label),
        control,
        config.hint ? h('p', { className: 'aihub-field__hint' }, config.hint) : null,
        errorNode(wrongPath));
    }

    function apiField(path, value, onChange) {
      return h('div', { className: 'aihub-field aihub-sup__api' },
        h('label', { className: 'aihub-field__label', htmlFor: fieldId(path) }, t('apiLabel')),
        h('select', {
          id: fieldId(path),
          className: 'aihub-input',
          value: value,
          disabled: disabled,
          'aria-invalid': ariaInvalid(path),
          'aria-describedby': ariaDescribed(path),
          onChange: event => onChange(event.currentTarget.value),
          onBlur: () => markTouched(path),
        }, API_CHOICES.map(choice => h('option', { key: choice, value: choice }, choice))),
        errorNode(path));
    }

    function statusLine() {
      if (busy) return { tone: 'idle', text: t('saving') };
      if (snapshot.notice === 'saved') return { tone: 'ok', text: t('saved') };
      if (snapshot.notice === 'invalid') return { tone: 'error', text: t('invalid', { n: snapshot.errors.length }) };
      if (snapshot.notice === 'rejected') {
        return { tone: 'error', text: snapshot.reason ? t('rejectedWith', { reason: snapshot.reason }) : t('rejected') };
      }
      if (snapshot.notice === 'failed') {
        return { tone: 'error', text: snapshot.reason ? t('failedWith', { reason: snapshot.reason }) : t('failed') };
      }
      if (snapshot.dirty === true) return { tone: 'warn', text: t('dirty') };
      return { tone: 'idle', text: '' };
    }

    function toggleReveal(key) {
      setRevealed(previous => {
        const next = Object.assign({}, previous);
        next[key] = previous[key] !== true;
        return next;
      });
    }

    function supplierRow(model, modelIndex, supplier, position) {
      const at = 'models.' + modelIndex + '.suppliers.' + position;
      const labelForAria = String(supplier.label === undefined || supplier.label === null ? '' : supplier.label).trim();
      const named = labelForAria === '' ? t('supplierN', { n: position + 1 }) : labelForAria;
      const isRevealed = revealed[supplier.id] === true;
      const last = model.suppliers.length - 1;
      return h('li', { key: supplier.id, className: 'aihub-sup', role: 'group', 'aria-label': t('supplierN', { n: position + 1 }) },
        h('div', { className: 'aihub-sup__head' },
          h('span', { className: 'aihub-sup__index', 'aria-hidden': 'true' }, '#' + (position + 1)),
          textField({
            path: at + '.label',
            label: t('labelLabel'),
            value: supplier.label,
            placeholder: t('labelPlaceholder'),
            onChange: value => {
              if (controller) controller.updateSupplierField(modelIndex, position, 'label', value);
            },
          }),
          apiField(at + '.api', supplier.api, value => {
            if (controller) controller.updateSupplierField(modelIndex, position, 'api', value);
          }),
          h('label', { className: 'aihub-check', htmlFor: fieldId(at + '.enabled') },
            h('input', {
              id: fieldId(at + '.enabled'),
              type: 'checkbox',
              checked: supplier.enabled !== false,
              disabled: disabled,
              onChange: event => {
                if (controller) controller.updateSupplierField(modelIndex, position, 'enabled', event.currentTarget.checked);
              },
            }),
            t('enabledLabel')),
          h('div', { className: 'aihub-sup__actions' },
            h('button', {
              type: 'button',
              className: 'aihub-btn aihub-btn--sm aihub-btn--icon',
              'aria-label': t('moveUpAria', { label: named }),
              disabled: disabled || position === 0,
              onClick: () => {
                if (controller) controller.moveSupplier(modelIndex, position, -1);
              },
            }, '\u2191'),
            h('button', {
              type: 'button',
              className: 'aihub-btn aihub-btn--sm aihub-btn--icon',
              'aria-label': t('moveDownAria', { label: named }),
              disabled: disabled || position === last,
              onClick: () => {
                if (controller) controller.moveSupplier(modelIndex, position, 1);
              },
            }, '\u2193'),
            h('button', {
              type: 'button',
              className: 'aihub-btn aihub-btn--sm aihub-btn--icon aihub-btn--danger',
              'aria-label': t('removeSupplierAria', { label: named }),
              disabled: disabled,
              onClick: () => {
                if (controller) controller.removeSupplier(modelIndex, position);
              },
            }, '\u2715'))),
        h('div', { className: 'aihub-sup__grid' },
          textField({
            path: at + '.baseURL',
            label: t('baseURLLabel'),
            value: supplier.baseURL,
            placeholder: t('baseURLPlaceholder'),
            onChange: value => {
              if (controller) controller.updateSupplierField(modelIndex, position, 'baseURL', value);
            },
          }),
          textField({
            path: at + '.model',
            label: t('modelIdLabel'),
            value: supplier.model,
            placeholder: t('modelIdPlaceholder'),
            onChange: value => {
              if (controller) controller.updateSupplierField(modelIndex, position, 'model', value);
            },
          }),
          textField({
            path: at + '.apiKey',
            label: t('apiKeyLabel'),
            value: supplier.apiKey,
            hint: t('apiKeyHint'),
            secret: true,
            revealed: isRevealed,
            onChange: value => {
              if (controller) controller.updateSupplierField(modelIndex, position, 'apiKey', value);
            },
            trailing: h('button', {
              type: 'button',
              className: 'aihub-btn aihub-btn--sm',
              'aria-pressed': isRevealed ? 'true' : 'false',
              'aria-label': (isRevealed ? t('hide') : t('show')) + ' ' + t('apiKeyLabel'),
              disabled: disabled,
              onClick: () => toggleReveal(supplier.id),
            }, isRevealed ? t('hide') : t('show')),
          })),
        h('details', { className: 'aihub-sup__more', open: supplier.headersText !== '' },
          h('summary', null, t('advancedHeaders')),
          h('div', { className: 'aihub-sup__moreBody' },
            h('label', { className: 'aihub-field__label', htmlFor: fieldId(at + '.headers') }, t('headersLabel')),
            h('textarea', {
              id: fieldId(at + '.headers'),
              className: 'aihub-input',
              rows: 2,
              value: supplier.headersText === undefined ? '' : supplier.headersText,
              placeholder: t('headersPlaceholder'),
              spellCheck: false,
              disabled: disabled,
              'aria-invalid': ariaInvalid(at + '.headers'),
              'aria-describedby': ariaDescribed(at + '.headers'),
              onChange: event => {
                if (controller) controller.updateSupplierField(modelIndex, position, 'headersText', event.currentTarget.value);
              },
              onBlur: () => markTouched(at + '.headers'),
            }),
            h('p', { className: 'aihub-field__hint' }, t('headersHint')),
            errorNode(at + '.headers'))));
    }

    function modelCard(model, index) {
      const at = 'models.' + index;
      const headingId = surfaceId + '-model-' + index;
      const suppliers = Array.isArray(model.suppliers) ? model.suppliers : [];
      return h('section', { key: model.id, className: 'aihub-model', 'aria-labelledby': headingId },
        h('div', { className: 'aihub-model__head' },
          h('div', { className: 'aihub-model__identity' },
            h('h3', { id: headingId }, t('modelN', { n: index + 1 })),
            h('code', { className: 'aihub-model__id' }, model.id)),
          h('button', {
            type: 'button',
            className: 'aihub-btn aihub-btn--sm aihub-btn--danger',
            disabled: disabled,
            onClick: () => {
              if (controller) controller.removeModel(index);
            },
          }, t('removeModel'))),
        h('div', { className: 'aihub-model__fields' },
          textField({
            path: at + '.name',
            label: t('nameLabel'),
            value: model.name,
            placeholder: t('namePlaceholder'),
            hint: t('nameHint'),
            className: 'aihub-field--wide',
            onChange: value => {
              if (controller) controller.updateModelField(index, 'name', value);
            },
          }),
          textField({
            path: at + '.contextWindow',
            label: t('contextLabel'),
            value: model.contextWindow,
            inputMode: 'numeric',
            onChange: value => {
              if (controller) controller.updateModelField(index, 'contextWindow', value);
            },
          }),
          textField({
            path: at + '.maxTokens',
            label: t('maxLabel'),
            value: model.maxTokens,
            inputMode: 'numeric',
            onChange: value => {
              if (controller) controller.updateModelField(index, 'maxTokens', value);
            },
          })),
        h('div', { className: 'aihub-model__vision' },
          h('label', { className: 'aihub-check', htmlFor: fieldId(at + '.vision') },
            h('input', {
              id: fieldId(at + '.vision'),
              type: 'checkbox',
              checked: model.vision === true,
              disabled: disabled,
              onChange: event => {
                if (controller) controller.updateModelField(index, 'vision', event.currentTarget.checked);
              },
            }),
            t('visionLabel'))),
        h('div', { className: 'aihub-model__suppliers' },
          h('div', { className: 'aihub-model__suppliersHead' },
            h('h4', null, t('suppliers')),
            h('p', { className: 'aihub__hint' }, t('switchHint'))),
          errorNode(at + '.suppliers'),
          h('ol', { className: 'aihub-suppliers' }, suppliers.map((supplier, position) => supplierRow(model, index, supplier, position))),
          h('button', {
            type: 'button',
            className: 'aihub-btn aihub-btn--dashed',
            disabled: disabled,
            onClick: () => {
              if (controller) controller.addSupplier(index);
            },
          }, '+ ' + t('addSupplier'))));
    }

    const addButton = h('button', {
      type: 'button',
      className: 'aihub-btn',
      disabled: disabled,
      onClick: () => {
        if (controller) controller.addModel();
      },
    }, t('addModel'));
    const discardButton = h('button', {
      type: 'button',
      className: 'aihub-btn',
      disabled: canSave !== true,
      onClick: () => {
        if (controller) controller.discard();
      },
    }, t('discard'));
    const saveButton = h('button', {
      type: 'button',
      className: 'aihub-btn aihub-btn--primary',
      disabled: canSave !== true,
      onClick: () => {
        if (!controller) return;
        const result = controller.save();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      },
    }, busy ? t('saving') : t('save'));
    const header = h('div', { className: 'aihub__head' },
      h('div', { className: 'aihub__headText' },
        h('h2', { id: titleId }, t('title')),
        h('p', { className: 'aihub__intro' }, t('intro'))),
      h('div', { className: 'aihub__toolbar' }, addButton, discardButton, saveButton));

    if (settings.view === 'summary') return h('p', { className: 'aihub__intro' }, t('intro'));

    if (snapshot.status !== 'ready') {
      const missing = snapshot.status === 'unavailable';
      return h('section', { className: 'aihub', 'aria-labelledby': titleId },
        header,
        h('p', { className: 'aihub-status' + (missing ? ' aihub-status--error' : ''), role: 'status', 'aria-live': 'polite' },
          missing ? t('unavailable') : t('loading')),
        missing ? h('p', { className: 'aihub__hint' }, t('unavailableHint')) : null);
    }

    const status = statusLine();
    const models = Array.isArray(snapshot.draft.models) ? snapshot.draft.models : [];
    return h('section', { className: 'aihub', 'aria-labelledby': titleId, 'aria-busy': busy ? true : undefined },
      header,
      h('p', {
        className: 'aihub-status aihub-status--' + status.tone,
        role: status.tone === 'error' ? 'alert' : 'status',
        'aria-live': 'polite',
      }, status.text),
      canEdit !== true ? h('p', { className: 'aihub__hint' }, t('readonly')) : null,
      snapshot.corrupt === true ? h('p', { className: 'aihub-status aihub-status--warn' }, t('corrupt')) : null,
      models.length === 0
        ? h('div', { className: 'aihub-empty' },
            h('p', { className: 'aihub-empty__title' }, t('empty')),
            h('p', { className: 'aihub__hint' }, t('emptyHint')))
        : h('div', { className: 'aihub__models' }, models.map((model, index) => modelCard(model, index))),
      h('div', { className: 'aihub__footer' },
        h('p', { className: 'aihub__hint' }, t('footerHint')),
        h('div', { className: 'aihub__toolbar' }, discardButton, saveButton)));
  }

  AihubSection.mount = next => {
    session = next && typeof next === 'object' ? next : null;
  };

  return AihubSection;
}
