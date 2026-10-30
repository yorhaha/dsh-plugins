/**
 * Shared harness for the dsh-stock Client half's local checks: one jsdom
 * browser, the module table the Harness module loader answers with, and light
 * stand-ins for the shared UI primitives.
 *
 * The Client half is served verbatim as a classic script and requests `react`
 * and `@deepseek-ai/dsh-client-ui-primitives` from the browser module table.
 * The real primitives bundle cannot load under Node — it imports CSS modules —
 * so these checks answer that request with components that render the props
 * they are given, and {@link assertPrimitiveNames} separately checks every name
 * the bundle asks for against the installed library's type declarations: a
 * renamed export is the drift that would blank the panel in the browser.
 *
 * Needs the browser dependencies this package declares, which resolve from the
 * plugin's own `node_modules`.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRequire = createRequire(new URL('../package.json', import.meta.url))

// The browser globals must exist BEFORE react-dom is loaded: it decides at
// import time whether the environment supports the `input` event, and a React
// DOM loaded without a document falls back to the keydown polyfill, where a
// typed value never reaches a controlled component's onChange.
const { JSDOM } = webRequire('jsdom')
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = webRequire('react')
const { renderToStaticMarkup } = webRequire('react-dom/server')
const { createRoot } = webRequire('react-dom/client')
const { act } = webRequire('react-dom/test-utils')

/** Primitives the Client half may request, and what each renders. */
const PRIMITIVES = {
  /** Renders a real button, so a check can press it. */
  Button: ({ variant, size, icon, children, ...rest }) => React.createElement(
    'button',
    { type: 'button', 'data-primitive': 'Button', 'data-variant': variant ?? 'ghost', 'data-size': size ?? 'md', ...rest },
    icon,
    children,
  ),
  /** Renders a real input, so a check can type into it. */
  Input: ({ icon, ...rest }) => React.createElement('input', { 'data-primitive': 'Input', ...rest }),
  /** Renders the anchor it was given, plus the open list's selectable rows. */
  Menu: ({ open, anchor, items, onSelect }) => React.createElement(
    'div',
    { 'data-primitive': 'Menu', 'data-open': open === true },
    anchor,
    open === true
      ? React.createElement(
          'div',
          { role: 'menu' },
          (items ?? []).filter(item => item.type === undefined).map(item => React.createElement(
            'button',
            {
              key: item.id,
              type: 'button',
              'data-menu-item': item.id,
              disabled: item.disabled === true,
              onClick: () => onSelect(item.id),
            },
            item.label,
          )),
        )
      : null,
  ),
  /** Carries the label onto the anchor, the way the real tooltip describes it. */
  Tooltip: ({ label, children }) => React.cloneElement(children, { 'data-tooltip': label }),
  /** Renders the banner text, and a control that reports the fade as done. */
  Toast: ({ text, tone, onDone }) => React.createElement(
    'div',
    { 'data-primitive': 'Toast', 'data-tone': tone ?? 'warning' },
    text,
    React.createElement('button', { type: 'button', 'data-toast-done': true, onClick: onDone }, 'done'),
  ),
  /** Renders the state it was asked for. */
  StateDot: ({ state }) => React.createElement('span', { 'data-primitive': 'StateDot', 'data-state': state }),
  /** Renders the badge with the palette it was given, as the real one marks it. */
  Tag: ({ tone = 'outline', className, children }) => React.createElement(
    'span',
    { 'data-primitive': 'Tag', 'data-tone': tone, className },
    children,
  ),
}

/** Icon components, each rendered as a marked span. */
const ICON_NAMES = [
  'IconChevronDownOutlineRegular',
  'IconChevronLeftOutlineRegular',
  'IconChevronRightOutlineRegular',
  'IconChevronUpOutlineRegular',
  'IconCloseOutlineRegular',
  'IconEllipsisOutlineMedium',
  'IconGaugeOutlineRegular',
  'IconPauseOutlineRegular',
  'IconPinOutlineRegular',
  'IconPlayOutlineRegular',
  'IconPlusOutlineRegular',
  'IconRefreshOutlineRegular',
  'IconSearchOutlineRegular',
  'IconTrashOutlineRegular',
  'IconWarningOutlineRegular',
]
for (const name of ICON_NAMES) {
  PRIMITIVES[name] = ({ size }) => React.createElement('span', { 'data-icon': name, 'data-icon-size': size })
}

/** Every name the Client half requests from the primitives module. */
export const REQUESTED_PRIMITIVES = Object.freeze([...Object.keys(PRIMITIVES)])

/**
 * Check every requested primitive against the shared library's own exports.
 *
 * @param names - the requested names.
 * @returns the names the library does not export.
 */
export function missingPrimitives(names) {
  const lib = fileURLToPath(new URL('.', import.meta.resolve('@deepseek-ai/dsh-client-ui-primitives')))
  const read = (...segments) => {
    try {
      return readFileSync(join(lib, 'types', ...segments), 'utf8')
    } catch {
      // A missing declaration file proves nothing about the export; the caller
      // treats an unreadable library as "every name is unverified".
      return ''
    }
  }
  const source = read('index.d.ts') + read('icons', 'index.d.ts')
  return names.filter(name => !new RegExp(`\\b${name}\\b`).test(source))
}

/**
 * Read and execute the Client half exactly as the module loader would.
 *
 * @returns the registration the bundle passed to `window.__ModuleLoader__.load`.
 */
export function loadClientModule() {
  let registration
  window.__ModuleLoader__ = { load: value => { registration = value } }
  new Function(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))()
  return registration
}

/**
 * Build the module-table require the loader hands a bundle.
 *
 * @returns the require function, which rejects any specifier the table does not hold.
 */
export function clientRequire() {
  return (name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return PRIMITIVES
    throw new Error(`the Client half requested an undeclared module: ${name}`)
  }
}

/**
 * Mount the Client half against a recording slot registry.
 *
 * @param options - mount inputs.
 * @param options.locale - the active locale the context's own binding resolves, default `zh`.
 * @returns the registered components by `slot:key`, the dictionaries, the requested slots, and the mount context.
 */
export function mountClientHalf({ locale = 'zh' } = {}) {
  const registration = loadClientModule()
  const dictionaries = {}
  const registered = new Map()
  const registrations = new Map()
  const requestedSlots = []
  const missing = new Set()
  const localeState = { active: locale }
  const mountContext = {
    effect: (callback) => {
      callback()
    },
    locale: {
      register: (namespace, dicts) => { dictionaries[namespace] = dicts },
      bind: namespace => translateFor(dictionaries, namespace, localeState.active, missing),
    },
    slots: {
      inject: (name, callback) => {
        requestedSlots.push(name)
        // A slot injection returns either one disposer or a generator of them.
        const result = callback()
        if (result !== null && typeof result === 'object' && typeof result[Symbol.iterator] === 'function') {
          for (const _ of result) { /* captured by register */ }
        }
      },
      register: (options, Component) => {
        const key = `${options.name}:${options.key ?? options.id}`
        registered.set(key, Component)
        registrations.set(key, options)
        return () => {}
      },
    },
  }
  const exported = registration.factory(clientRequire())
  exported.apply(mountContext)
  return { registration, exported, dictionaries, registered, registrations, requestedSlots, localeState, missing }
}

/**
 * Build a translate function over a registered dictionary, recording every key it misses.
 *
 * @param dictionaries - the registered namespace dictionaries.
 * @param namespace - the namespace to read.
 * @param locale - the locale id.
 * @param missing - a set the missed keys are added to.
 * @returns the translate function.
 */
export function translateFor(dictionaries, namespace, locale, missing) {
  return (key, params) => {
    const template = dictionaries[namespace]?.[locale]?.[key]
    if (template === undefined) {
      missing.add(`${locale}:${key}`)
      return key
    }
    return params === undefined
      ? template
      : template.replace(/\{(\w+)\}/g, (all, name) => (name in params ? String(params[name]) : all))
  }
}

/**
 * Set one input's value the way a person typing does, so React's change event fires.
 *
 * @param input - the input element.
 * @param value - the new value.
 */
export function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

export { React, window, dom, renderToStaticMarkup, createRoot, act }
