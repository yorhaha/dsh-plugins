/**
 * Shared harness for the dsh-stock Host half's local checks: an in-memory
 * storage-domain facility and a stub context that mounts the real plugin the
 * way the Loader would.
 *
 * The storage stand-in is built from the spec the plugin declares, so every
 * write is validated through the spec's own schema: a document that does not
 * match fails in the check instead of at the next open. It outlives `close`,
 * which is what lets a check reopen the same list as a restart does.
 *
 * Run from the plugin directory after `pnpm install`.
 */
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { apply } from '../index.js'
import { BRIDGE_PATH } from '../src/bridge.js'

/**
 * In-memory stand-in for the mounted storage domain.
 *
 * @returns the facility, exposing the opened spec and the stored document.
 */
export function fakeStorageDomain() {
  const tables = new Map()
  let spec = null
  let document = null
  let opened = false
  return {
    get spec() {
      return spec
    },
    get document() {
      return document
    },
    get isOpen() {
      return opened
    },
    async open(value) {
      if (opened) throw new Error('stock: the storage domain is already open')
      opened = true
      spec = value
      if (document === null) document = structuredClone(value.global.initial)
      return {
        name: value.name,
        global: {
          get: () => document,
          set: async (next) => {
            if (!opened) throw new Error('stock: the storage domain is closed')
            document = value.global.schema.parse(next)
          },
        },
        table: (name) => {
          const declared = value.tables[name]
          if (declared === undefined) throw new Error(`stock: the domain declares no table '${name}'`)
          if (!tables.has(name)) tables.set(name, new Map())
          const store = tables.get(name)
          return {
            get: (key) => store.get(key),
            entries: () => [...store.entries()][Symbol.iterator](),
            keys: () => [...store.keys()][Symbol.iterator](),
            get size() {
              return store.size
            },
            put: async (key, record) => {
              store.set(key, declared.valueSchema.parse(record))
            },
            delete: async (key) => store.delete(key),
            update: async (key, mutate) => {
              const next = declared.valueSchema.parse(mutate(store.get(key)))
              store.set(key, next)
              return next
            },
          }
        },
        close: async () => {
          opened = false
        },
      }
    },
  }
}

/**
 * Mount the plugin against stub services, as the Loader would.
 *
 * @param options - mount inputs.
 * @param options.facility - the storage domain facility the plugin opens.
 * @param options.config - the row's `config`, validated by the plugin.
 * @param options.withConnection - whether a Connection service is mounted, which the panel route needs.
 * @param options.failToolAt - make the nth tool registration throw, which is how a hot reload that disposes the fiber mid-setup fails.
 * @returns the registered tools by name, the registered prompt sections, the captured warnings, the captured route, and the lifecycle disposer.
 */
export async function mountHost({ facility, config, withConnection = false, failToolAt }) {
  const tools = new Map()
  const sections = []
  const warnings = []
  let route
  const ctx = {
    logger: { info() {}, debug() {}, warn: (message) => warnings.push(message), error() {} },
    storageDomain: facility,
    // Only MCP_SERVERS is reachable: `getSectionOrder` throws on an unknown
    // name, so a mistyped order fails the mount here as it would at load.
    systemPrompt: {
      getSectionOrder(name) {
        if (name !== 'MCP_SERVERS') throw new Error(`stock: unexpected section order name '${name}'`)
        return 3100
      },
      section(section) {
        sections.push(section)
        return () => {
          const at = sections.indexOf(section)
          if (at >= 0) sections.splice(at, 1)
        }
      },
    },
    tools: {
      register(definition) {
        assertSupportedJsonSchema(definition.parameters)
        assertSupportedJsonSchema(definition.output.schema)
        if (tools.size + 1 === failToolAt) throw new Error('stock: simulated registration failure')
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect: (body) => body(),
    inject: (names, callback) => {
      if (!withConnection || !names.includes('connection')) return undefined
      return callback({
        connection: {
          fetch: {
            register: (registration) => {
              route = registration
              return () => {
                route = undefined
              }
            },
          },
        },
        effect: (work) => {
          const cleanup = work()
          return () => cleanup?.()
        },
      })
    },
  }
  const dispose = await apply(ctx, config)
  return { tools, sections, warnings, route: () => route, dispose }
}

/**
 * Post one panel action to the captured route.
 *
 * @param route - the captured route registration.
 * @param body - the JSON request body.
 * @returns the response status and its parsed payload.
 */
export async function postRoute(route, body) {
  const response = await route.fetch(new Request(`http://harness.test${BRIDGE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: response.status, payload: await response.json() }
}
