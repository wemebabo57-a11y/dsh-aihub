# dsh-aihub 接口契约（Host / 浏览器两个半身共同遵守）

> 这份文件是唯一的跨模块约定。改动它必须先通知另一半身，再改代码。

## 1. 目标（用户原始需求）

1. 设置里有一个 **插件专用设置区**（不混进原生表单）。
2. 操作简洁：创建模型 → 填显示名称 → 下方填多个「供应方 + 实际调用的模型」。
3. 某个供应方接不上时，**自动切到下一个**（顺序即用户排序）。
4. 设置完成后，模型选择区出现 **供应商为 `aihub`** 的条目，下面列出所创建模型的显示名称，且能正常调用。

## 2. 固定标识

| 项 | 值 | 说明 |
| --- | --- | --- |
| npm 包名 | `dsh-aihub` | `package.json` / bundle patch |
| Cordis 条目 id | `aihub` | `cordis.patch.yml` 的 `id:`；**同时是 Settings 命名空间** |
| LLM 路由（provider） | `aihub` | `ctx.llm.registerAdapter(['aihub'], …)` |
| 设置项字段 | `state` | 单个 `.volatile()` 字符串字段，内容是下节 JSON |
| 客户端半身 | `client/client.js` | bundle 由 `scripts/build-ui.mjs` 生成 |

`form.set('state', <json 字符串>)` 是浏览器半身**唯一**的持久化通道：没有自定义 RPC，没有额外 HTTP 端口。所有校验都发生在这条通道两侧。

## 3. `state` JSON（version 1）

```json
{
  "version": 1,
  "models": [
    {
      "id": "m_7f3a91",
      "name": "写作 · 主力",
      "contextWindow": 128000,
      "maxTokens": 8192,
      "vision": false,
      "suppliers": [
        {
          "id": "s_1",
          "label": "OpenAI 官方",
          "api": "openai-completions",
          "baseURL": "https://api.openai.com/v1",
          "model": "gpt-5",
          "apiKey": "sk-…",
          "headers": {},
          "enabled": true
        },
        {
          "id": "s_2",
          "label": "备用中转",
          "api": "openai-completions",
          "baseURL": "https://relay.example.com/v1",
          "model": "gpt-5",
          "apiKey": "sk-…",
          "headers": { "X-Tenant": "me" },
          "enabled": true
        }
      ]
    }
  ]
}
```

约束：

- `id`：`^[A-Za-z0-9_-]{1,64}$`，创建后不再变化（`name` 可改；`id` 是传给 `options.model` 的值）。
- `name`：1–80 字符，模型选择器里显示的就是它。允许重复（id 不同）。
- `contextWindow`：1000–2000000，默认 128000；`maxTokens`：1–131072，默认 8192；`vision`：布尔，默认 false。
- `suppliers`：数组顺序 = 切换顺序；只考虑 `enabled !== false` 的项；同一模型至少要有一个启用的供应方。
- `api`：`"openai-completions"`（默认）或 `"anthropic-messages"`。
- `baseURL`：http/https，末尾斜杠会被规整掉（`…/v1/` → `…/v1`）。
- `model`：供应方侧真实模型 id（如 `gpt-5`、`deepseek-chat`、`kimi-k2`）。
- `apiKey`：字符串。**注意：明文存在 profile 的 `cordis.patch.yml` 里**（DSH 的 volatile 配置落盘就是这样）。允许空字符串——此时按 `env:变量名` 约定解析，例如 `apiKey: "env:OPENAI_API_KEY"`。
- `headers`：可选，字符串→字符串。
- 未知字段保留（前向兼容），但写入时应原样回传未识别的顶层键。

**损坏的 `state` 不得让宿主崩溃**：读路径解析失败一律退化成空 hub（0 个模型）。

## 4. Host 半身

```
src/index.mjs          # 已写好：Config、settings 策略、registerAdapter、volatile-update → llm/models-updated
src/host/state.mjs     # 由 host 负责人实现
src/host/adapter.mjs   # 由 host 负责人实现
```

### 4.1 `src/host/state.mjs`

必须导出：

- `export const EMPTY_STATE` —— 冻结的空 state（`{ version: 1, models: [] }`）。
- `export function parseState(text)` —— 容错解析：非字符串 / 空串 / 非法 JSON / 结构不对 → `EMPTY_STATE`；合法则返回**规整后**的对象（补默认值、丢弃无效供应方、规整 baseURL）。
- `export function readStateText(ref)` —— 读配置引用：支持 `string`、`{ get(): string }`、`undefined`，返回字符串。
- `export function validateState(text)` —— 写路径校验；**必须抛 `Error`**，message 是给用户看的中文诊断（会经 `internal/config` 拒绝这次写入）。空字符串视为合法（= 清空）。

### 4.2 `src/host/adapter.mjs`

`export function createAihubAdapter({ route, readState, attachments, logger })` 返回一个 `@deepseek-ai/dsh-llm` 的 `LlmAdapter` 形状对象（结构鸭子类型即可，不要 import 内核包）：

- `attachments`：可选，`() => ctx.get('attachments')`（`src/index.mjs` 已注入）。返回 `undefined` 时按纯文本处理图片。

- `providerInfo(provider)` → `{ id: 'aihub', name: 'aihub' }`（名字按用户要求就是 aihub）。
- `listModels(provider)` → 当前 `readState().models` 映射成 `LlmModelInfo`：`{ id, name, provider, contextWindow, maxTokens, inputModalities: vision ? ['text','image'] : ['text'] }`，字段名以 `dsh-llm` 的 `lib/types/index.js` 为准（**实现前先读它**）。
- `resolveModel(provider, model, signal)` → 该模型元数据；未知 id 抛 `LlmError('…', 'INVALID_CONFIG')`（若拿不到 `LlmError`，抛带 `code` 属性的 Error）。
- `prepareCall(provider, model, signal)` → `{ model: <元数据>, stream: options => … }`。
- `stream(options)` → 返回 async iterable / async generator，产出 `@deepseek-ai/dsh-llm` 的 `StreamChunk` 序列，且**恰好以一个终止 `finish` 收尾**。

### 4.3 失败切换（核心行为）

- 依 `suppliers` 顺序尝试（跳过 `enabled === false`）。
- **冷却只排序，不裁剪**：某个供应方在产出内容之前失败后，30 秒内排到链尾
  （`DEFAULT_COOLDOWN_MS`，可用 `createAihubAdapter({ cooldownMs })` 覆盖，0 关闭）。
  这样做是为了让下一轮不必再等它一次超时；它仍在链上，全部失败时照样会试到，
  成功一次即恢复原序。冷却状态只在进程内存里，重启即清空。
- **首个可见内容块产出之前**的任何失败（连接错误、超时、HTTP 非 2xx、SSE 里第一个 `error` 事件）→ 记一条 warn 日志（写清 `label`/`model`/原因，**绝不打印 apiKey**），换下一个供应方。
- 首个可见内容之后失败 → 不能重来：发出 `finish: { kind: 'error', failure }`，并抑制后续供应方尝试。
- 全部失败 → `finish: { kind: 'error', failure }`，failure 汇总每个供应方的失败原因（至少包含首个与最后一个）。取消信号（`options.signal`）→ `{ kind: 'aborted', … }`。
- 连接超时：默认 30s 建立首个响应；供应方内部流空闲超时 120s。
- 用法（usage）/缓存 token 按实际响应透传；不确定的字段宁可不填。

### 4.4 请求/响应翻译

- `api: 'openai-completions'`：`POST {baseURL}/chat/completions`，`stream: true`，SSE 逐行解析 `data: {...}`。
- `api: 'anthropic-messages'`：`POST {baseURL}/v1/messages`（baseURL 已含 `/v1` 时不重复拼接），`x-api-key` + `anthropic-version: 2023-06-01`。
- 工具调用、图片、思考块必须按 `dsh-llm` 的 chunk 词汇映射，保证 agent 能正常用（这是「可正常调用」的验收点）。
- 图片：请求里的图片块是 `{ type: 'image', attachment: { attachmentId, variantId, mediaType, width, height, name? } }`。`vision: true` 的模型经 `attachments().readImageRequest(ref, { width, height, maxBytes }, signal)` 取 `{ data: Uint8Array, mediaType, … }`；取不到就把该图降级成文本占位并 warn 一次，**不得让整个请求失败**。线格式：OpenAI 兼容 → `{ type: 'image_url', image_url: { url: 'data:<mt>;base64,…' } }`；Anthropic → `{ type: 'image', source: { type: 'base64', media_type, data } }`（Anthropic 的 assistant 历史里不放图）。
- 请求头必须带 `attributionHeaders()`（可从 `@deepseek-ai/dsh-llm` 懒加载，失败就退化成常量 UA）。

### 4.5 宿主验收

- `node --test test/host` 用 `globalThis.fetch` 假实现覆盖：成功、首个供应方 401 → 切第二个、SSE 中途断流、全部失败、取消、工具调用、损坏 state。
- 不联网跑通即可交付；真机联调由 Lead 在 GUI 里做。

## 5. 浏览器半身

```
src/client/index.mjs      # createClientPlugin(React)，inject = ['slots','locale','configForms']
src/client/controller.mjs # 草稿 / 保存 / 校验（对 configForms 的薄封装）
src/client/view.mjs       # 界面 + CSS
scripts/build-ui.mjs      # 零依赖打包成 client/client.js
```

bundle 格式（照抄 `dsh-strong-skills`，见 `scripts/build-ui.mjs`）：

```js
window.__ModuleLoader__.load({ id: 'dsh-aihub', factory: (require) => {
'use strict';
/* …拼接的源码… */
return createClientPlugin(require('react'));
} });
```

注册设置区（唯一入口）：

```js
ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'aihub', order: 40,
  label: () => t('title'), locale: 'settings.aihub', inject: () => face(),
}, AihubSettings)))
```

`ctx.configForms.get('aihub')` → form：`getSnapshot()`（`{status, value, writable}`，`value.state` 是字符串）、`subscribe(fn)`、`set('state', json)`、`mutate([{op, path}])`。

### 5.1 交互（简洁优先）

- 一屏完成：顶部一句说明 + 「新建模型」；每个模型一张卡片，卡片内是显示名、上下文/输出上限、供应方行（按顺序，可上移/下移/删除/启用）。
- 编辑是**本地草稿**；顶部或卡片底部的「保存」一次性 `form.set('state', JSON.stringify(draft))`。有未保存修改时按钮可用并给出 `未保存` 提示；保存失败展示宿主拒绝原因。
- 空态：一句「还没有模型」+ 指向「新建模型」。
- 每行供应方必须能一眼看出：标签、协议、Base URL、模型 id、API Key（默认掩码，可切换显示）。
- 校验在浏览器侧先做（与 `validateState` 同规则，中文行内报错），宿主是第二道闸。
- 语言：中文，跟随 DSH 语言服务（`ctx.locale.register('settings.aihub', { zh, en })` + `bind`）。

### 5.2 视觉

- 只用 DSH 主题 token（`--dsw-alias-*`），深浅色都要可读；不要蓝紫渐变、不要大标题卡片堆叠。
- 强调色用主题业务色；危险操作（删除）用错误色；焦点态 2px 描边且对比度达标。
- 容器 `max-width: 760px`，与原生设置页节奏一致（参考 `dsh-strong-skills/client/view.mjs` 的 CSS 变量用法）。

### 5.3 验收

- `node scripts/build-ui.mjs` 生成 bundle，`node scripts/build-ui.mjs --check` 不报 stale。
- 在测试 profile 里装好后，设置左侧出现 AI Hub 专区；新建模型 → 保存 → 刷新后仍在；模型选择器出现 `aihub` 下该模型名。

## 6. 安装与联调（Lead 负责）

```
node scripts/build-ui.mjs
dsh plugin --profile <profile> add "link:F:/000build/ai-tool/dsh-freehub"
```

先装进一次性测试 profile（例如 `aihub-dev`）验证，再装进日常使用的 profile。
`package.json` 的 `dsh.client.immediately` 必须为 `true`：缺了它客户端 bundle 会发到浏览器但不执行，
而且不报错（表现为「设置页里根本没有这一项」）。

## 7. 文件归属（并行写权限，勿越界）

| 范围 | 负责人 |
| --- | --- |
| `src/host/**`、`test/host/**` | host 负责人 |
| `src/client/**`、`scripts/build-ui.mjs`、`client/**` | 浏览器负责人 |
| `src/index.mjs`、`package.json`、`cordis.patch.yml`、`locale/**`、`icon.svg`、`docs/**`、`README.md` | Lead |
