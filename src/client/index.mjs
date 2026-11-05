/**
 * dsh-aihub browser half — client entry.
 *
 * A lazy client bundle: the Host calls the factory below, the factory returns a
 * Cordis plugin, and the plugin mounts one settings section. The document lives
 * in the Host settings namespace 'aihub'; this file only wires the draft store
 * from controller.mjs to the section from view.mjs, plus the locale, the style
 * tag, and the optional diagnostic writer used when a save is refused.
 * @module dsh-aihub/client
 */

import { createAihubController, SETTINGS_ENTRY, SETTINGS_NS, STATE_FIELD } from './controller.mjs';
import { AIHUB_CSS, EN, ZH, createAihubSection, interpolate } from './view.mjs';

/** Services this plugin needs from the Host shell. */
export const inject = ['slots', 'locale', 'configForms'];

/** One language per call, for locale services that predate the two-dictionary form. */
function registerDictionaries(ctx) {
  const locale = ctx.locale;
  if (!locale || typeof locale.register !== 'function') return;
  try {
    locale.register(SETTINGS_NS, { en: EN, zh: ZH });
    return;
  } catch (error) {
    // Older locale service: register each language separately.
  }
  try {
    locale.register(SETTINGS_NS, 'zh', ZH);
  } catch (error) {
    // Keep going: the English copy below is the last resort.
  }
  try {
    locale.register(SETTINGS_NS, 'en', EN);
  } catch (error) {
    // Keep going: the section falls back to the bundled English copy.
  }
}

/** Translate through the Host locale service, falling back to this bundle. */
function bindText(ctx) {
  try {
    const locale = ctx.locale;
    const bound = locale && typeof locale.bind === 'function' ? locale.bind(SETTINGS_NS) : null;
    if (typeof bound === 'function') {
      return (key, vars) => {
        const text = bound(key);
        const copy = typeof text === 'string' && text !== key ? text : EN[key] === undefined ? key : EN[key];
        return interpolate(copy, vars);
      };
    }
  } catch (error) {
    // Fall through to the bundled English copy.
  }
  return (key, vars) => interpolate(EN[key] === undefined ? key : EN[key], vars);
}

function reasonOf(response) {
  if (response && response.error && typeof response.error.message === 'string') return response.error.message;
  return '';
}

/**
 * The configuration form reports a refused save as false and drops the reason.
 * This writer re-sends the very same document through the standard settings
 * remote once, only to read the Host answer: when the Host accepts it the save
 * really happened, and when it refuses, its message is what the section shows.
 */
function createProbe(ctx) {
  let api = null;
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['remote', 'remote.settings'], scope => {
        api = scope && scope.remote && scope.remote.settings ? scope.remote.settings : null;
      });
    }
  } catch (error) {
    api = null;
  }
  return async function probe(text) {
    if (!api || typeof api.describe !== 'function' || typeof api.mutate !== 'function') return null;
    try {
      const described = await api.describe();
      if (!described || described.ok !== true) return { ok: false, reason: reasonOf(described) };
      const rows = described.value && Array.isArray(described.value.namespaces) ? described.value.namespaces : [];
      let revision;
      for (const row of rows) {
        if (row && row.ns === SETTINGS_ENTRY) revision = row.revision;
      }
      const response = await api.mutate(SETTINGS_ENTRY, [{ op: 'set', path: [STATE_FIELD], value: text }], revision);
      if (response && response.ok === true) return { ok: true, reason: '' };
      return { ok: false, reason: reasonOf(response) };
    } catch (error) {
      return { ok: false, reason: error && error.message ? String(error.message) : '' };
    }
  };
}

/** Build the client plugin around the Host React instance. */
export function createClientPlugin(React) {
  const Section = createAihubSection(React);

  return {
    name: 'dsh-aihub',
    inject,
    apply(ctx) {
      const doc = typeof document === 'undefined' ? null : document;
      if (doc) {
        ctx.effect(() => {
          const style = doc.createElement('style');
          style.setAttribute('data-plugin', 'dsh-aihub');
          style.textContent = AIHUB_CSS;
          doc.head.appendChild(style);
          return () => {
            if (style.parentNode) style.parentNode.removeChild(style);
          };
        }, 'aihub: section styles');
      }

      ctx.effect(() => registerDictionaries(ctx), 'aihub: dictionaries');
      const t = bindText(ctx);

      const form = ctx.configForms && typeof ctx.configForms.get === 'function' ? ctx.configForms.get(SETTINGS_ENTRY) : null;
      const controller = createAihubController(form, { probe: createProbe(ctx) });
      ctx.effect(() => () => controller.dispose(), 'aihub: draft store');

      Section.mount({ controller, t });

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SETTINGS_ENTRY,
        order: 40,
        label: () => t('title'),
        locale: SETTINGS_NS,
        inject: () => ({
          surfaceId: 'aihub-settings',
          hooks: { aihubDraft: controller.store },
          reset: () => controller.discard(),
        }),
      }, Section)), 'aihub: settings section');
    },
  };
}
