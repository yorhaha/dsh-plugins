/**
 * Shared harness for this bundle's local checks: an in-memory storage-domain
 * facility, a stub plugin context, and a stub Connection channel that mounts the
 * real plugin the way the Loader would.
 *
 * The storage stand-in is built from the spec the plugin declares, so every
 * write is validated through the spec's own zod schema: a document that does not
 * match fails the check instead of at the next open. It outlives the plugin's
 * unload, which is what lets a check reopen the list as a restart does.
 *
 * @module dsh-user-todo/tests/harness
 */

import { apply } from '../index.js'

/** A config block stating this bundle's own defaults, as its patch does. */
export const DEFAULT_CONFIG = {
  toolNames: {
    list: 'list_user_todos',
    create: 'create_user_todos',
    update: 'update_user_todos',
    agenda: 'list_user_agenda',
  },
  maxCreateBatch: 20,
  maxUpdateBatch: 50,
  maxTitleChars: 200,
  maxNoteChars: 2000,
  maxItems: 5000,
  allowSubagentWrites: true,
  // The zone is pinned so a check that names a local time has one answer on
  // every machine; the deployment default is the system zone.
  timeZone: 'Asia/Shanghai',
  agendaMaxSpanDays: 366,
  agendaMaxOccurrences: 400,
  remindCatchUpHours: 24,
  maxPushesPerHour: 6,
  schedulerMaxSleepMs: 60_000,
}

/**
 * In-memory stand-in for the mounted storage domain.
 *
 * @returns the facility: `document` is the stored global (null until written),
 * `openCount` counts successful opens, and `opened` reports the current handle.
 */
export function fakeStorageDomain() {
  let document = null
  let handle = null
  let openCount = 0
  const facility = {
    /**
     * Place a document on the medium before the plugin opens it, as a previous
     * version of this bundle would have left it.
     *
     * @param value - the stored global.
     */
    seed(value) { document = structuredClone(value) },
    get document() { return document },
    get openCount() { return openCount },
    get isOpen() { return handle !== null },
    get handle() { return handle },
    async open(spec) {
      if (handle !== null) throw new Error('user-todo: the storage domain is already open')
      openCount += 1
      const initial = structuredClone(spec.global.initial)
      // The real facility validates every stored record against the spec when it
      // opens a domain, and the schema's defaults fill what an older document
      // never wrote. Parsing here keeps a check honest about both behaviors: a
      // document that no longer validates must fail the open, and a document
      // written before a field existed must open with that field defaulted.
      document = document === null ? initial : spec.global.schema.parse(document)
      const opened = {
        name: spec.name,
        global: {
          // The real domain refuses a read once it is closed, exactly as it does
          // a write, and signals it with `code: 'closed'` — the code the store
          // discriminates on. A stub that kept answering would hide the shutdown
          // race the reminder loop has to survive.
          get: () => {
            if (handle !== opened) {
              throw Object.assign(new Error("domain 'user_todo' is closed"), { code: 'closed' })
            }
            return document
          },
          set: async (next) => {
            if (handle !== opened) throw new Error('user-todo: the storage domain is closed')
            document = spec.global.schema.parse(next)
          },
        },
        table: () => { throw new Error('user-todo: the domain declares no tables') },
        close: async () => {
          if (handle === opened) handle = null
        },
      }
      handle = opened
      return opened
    },
    get(name) { return handle?.name === name ? handle : undefined },
    async closeAll() { handle = null },
  }
  return facility
}

/**
 * A Connection channel recording the routes the plugin registers.
 *
 * @returns the channel, with `routes` (path to handler) and `fetch(path, init)`.
 */
export function fakeConnection() {
  const routes = new Map()
  return {
    routes,
    fetch: {
      register: (route) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    async request(target, { method = 'GET', body, rawBody, url = 'http://localhost' } = {}) {
      const path = target.split('?')[0]
      const route = routes.get(path)
      if (route === undefined) throw new Error(`user-todo: no route at ${path}`)
      const payload = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body)
      return route.fetch(new Request(`${url}${target}`, { method, body: payload }))
    },
  }
}

/**
 * A stub Cordis context carrying the registries the plugin touches.
 *
 * `effect` runs the callback immediately and keeps its cleanup, which is how the
 * real fiber settles: the mount has finished by the time `mount` returns.
 *
 * @param options - the storage facility and the connection channel to provide.
 * @returns the context, with `tools` (name to definition), `emitted` (event and
 * payload pairs), and `dispose()` to unload the plugin.
 */
export function fakeContext({ storageDomain, connection, services = new Map() }) {
  const tools = new Map()
  const emitted = []
  const cleanups = []
  const failures = []
  const warnings = []
  /**
   * Register one effect body.
   *
   * `ctx.effect` mirrors the real fiber: a synchronous throw escapes, an async
   * body's rejection is contained and logged (the fiber catches it to keep the
   * process alive), and a generator body is drained as an injection effect.
   *
   * @param callback - the effect body.
   * @returns a synchronous disposer, as the real overload does.
   */
  const effect = (callback) => {
    let result
    try {
      result = callback()
    } catch (error) {
      throw error
    }
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      cleanups.push(Promise.resolve(result).then((cleanup) => {
        if (typeof cleanup === 'function') return cleanup
        return undefined
      }, (error) => {
        failures.push(error)
        return undefined
      }))
      return () => {}
    }
    if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
      for (const _ of result) void _
      return () => {}
    }
    if (typeof result === 'function') cleanups.push(Promise.resolve(result))
    return () => {}
  }
  const ctx = {
    storageDomain,
    connection,
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect,
    inject(_keys, callback) {
      callback(ctx)
      return () => {}
    },
    emit(event, payload) { emitted.push([event, payload]) },
    /**
     * Optional services, as `ctx.get` sees them. An installer that is absent from
     * the profile is `undefined` here, which is what the reminder loop must
     * survive.
     */
    get(name) { return services.get(name) },
    logger: {
      warn(message) { warnings.push(String(message)) },
      info() {},
      debug() {},
      error(error) { failures.push(error) },
    },
    tools_map: tools,
    emitted,
    failures,
    warnings,
    async settled() {
      await Promise.all(cleanups.map(entry => entry.catch(() => undefined)))
      if (failures.length > 0) throw failures[0]
    },
    async dispose() {
      while (cleanups.length > 0) {
        const cleanup = await cleanups.pop()
        if (typeof cleanup === 'function') await cleanup()
      }
      tools.clear()
    },
  }
  return ctx
}

/**
 * Mount the plugin exactly as the Loader would.
 *
 * `config` overrides one field at a time on top of {@link DEFAULT_CONFIG}, so
 * a check states only what it changes.
 *
 * @param options - overrides for the config block, and optional storage domain
 * or connection channel to mount over.
 * @returns the mounted plugin: its context, storage facility, connection
 * channel, and the tool map.
 */
export async function mount(options = {}) {
  const storageDomain = options.storageDomain ?? fakeStorageDomain()
  const connection = options.connection ?? fakeConnection()
  const services = new Map(Object.entries(options.services ?? {}))
  const ctx = fakeContext({ storageDomain, connection, services })
  const config = { ...DEFAULT_CONFIG, ...options.config }
  await apply(ctx, config)
  // The mount's asynchronous work is an effect body: wait for its own promise
  // before treating the plugin as mounted.
  await ctx.settled()
  return { ctx, storageDomain, connection, tools: ctx.tools_map, config }
}
