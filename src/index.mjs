/**
 * dsh-aihub — Host half.
 *
 * One Cordis plugin that owns a single LLM route, `aihub`. The route's catalog
 * comes from this plugin's own settings field: the user creates models there,
 * each model listing several provider endpoints that serve it, and the adapter
 * fails over between them. Everything the adapter needs is read from the live
 * config reference, so a saved change reaches the next request without a
 * restart.
 *
 * Module boundaries live in docs/contract.md; the adapter and the state codec
 * are the two seams this file consumes.
 * @module dsh-aihub
 */
import { createAihubAdapter } from './host/adapter.mjs'
import { parseState, readStateText, validateState } from './host/state.mjs'

/** Cordis plugin name; also the bundle-patch id used by Settings. */
export const name = 'aihub'
/** The only service this plugin needs: the adapter registry. */
export const inject = ['llm']
/** The provider route every created model is served under. */
export const ROUTE = 'aihub'

/**
 * Config = one volatile JSON field.
 *
 * The field is a JSON document rather than a nested schema so that a model's
 * provider list can be reordered, renamed and extended without a schema bump,
 * and so the panel that edits it is the only validator authority on the wire.
 * `.volatile()` is what lets Settings edit it live and what makes the loader
 * announce the change through `loader/volatile-update`.
 */
export const Config = await loadConfigSchema()

/** Resolve Schemastery from the host, or degrade to a standard-schema stub. */
async function loadConfigSchema() {
  try {
    const { default: z } = await import('@deepseek-ai/schemastery')
    return z.object({
      state: z.string().default('').description('AI Hub 模型与供应方（JSON；由插件专用面板编辑）').volatile(),
    })
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes('@deepseek-ai/schemastery')) throw error
    // Dependency-free compositions (contract tests, headless kernels) still mount.
    return {
      '~standard': {
        version: 1,
        vendor: 'dsh-aihub',
        validate(value) {
          try {
            validateState(readStateText(value?.state))
            return { value: { state: readStateText(value?.state) } }
          } catch (cause) {
            return { issues: [{ message: cause.message }] }
          }
        },
      },
    }
  }
}

/**
 * Mount the plugin.
 * @param ctx - the Cordis context of this entry.
 * @param config - the entry config; `config.state` is a live reference.
 */
export function apply(ctx, config) {
  // A custom settings surface exists, so the generated form would be a second,
  // weaker editor for the same JSON: opt out while staying readable.
  ctx.inject(['settings'], (child) => {
    if (typeof child?.settings?.configure !== 'function' || typeof child.effect !== 'function') return
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'aihub: dedicated settings surface')
  })

  /** The current document. Reads are total: a half-written config yields an empty hub. */
  const readState = () => parseState(readStateText(config?.state))

  // Reject a write the adapter could not serve, before it reaches the patch file.
  ctx.on('internal/config', (fiber, next) => {
    const raw = next()
    if (fiber !== ctx.fiber) return raw
    validateState(readStateText(raw?.state))
    return raw
  })

  // Vision models read real bytes through the attachment store; a kernel
  // without one simply reports no bytes and the adapter falls back to text.
  const attachments = () => {
    try {
      return ctx.get('attachments')
    } catch {
      return undefined
    }
  }

  const adapter = createAihubAdapter({ route: ROUTE, readState, attachments, logger: ctx.logger })
  ctx.llm.registerAdapter([ROUTE], adapter)

  // The picker caches the catalog per session, but it refreshes on
  // `settings/document-updated` — which the settings service emits for this
  // write — so nothing has to be invalidated from here. This listener only
  // makes the new count visible in the log.
  ctx.on('loader/volatile-update', () => {
    try {
      // The edit is probably a fix for whatever just failed, so the next turn
      // starts from the document's order again.
      adapter.resetHealth?.()
      const models = readState().models
      ctx.logger.info?.(`aihub: ${models.length} model(s) advertised after a settings change`)
    } catch (error) {
      ctx.logger.error?.('aihub: the saved settings could not be read back')
      ctx.logger.error?.(error)
    }
  })

  const models = readState().models
  ctx.logger.info?.(`aihub: route ready with ${models.length} model(s)`)
}
