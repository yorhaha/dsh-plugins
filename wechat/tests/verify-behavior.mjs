/**
 * Deterministic behaviour checks for the dsh-wechat bundle.
 *
 * Everything here is offline: it builds synthetic export batches, runs the real
 * parser, importer, corpus, status probe, tools, and settings bridge, and
 * validates every tool value against the schema that tool declares.
 *
 * Run from the plugin directory after `pnpm install`:
 *   node tests/verify-behavior.mjs
 *
 * @module dsh-wechat/tests/verify-behavior
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import * as plugin from '../index.js'
import { Config, resolveOptions, validate } from '../src/config.js'
import { WechatImporter } from '../src/importer.js'
import { pipelineStatus } from '../src/status.js'
import { openStore } from '../src/store.js'
import { LocalClock } from '../src/time.js'
import { ALICE_RECORDS, brokenBatches, writeBatch } from './fixture.mjs'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const show = (value) => JSON.stringify(value ?? null)?.slice(0, 300) ?? 'undefined'

/** Check a tool value against the schema that tool declares. */
const accepts = (label, definition, value) => {
  let problems = []
  try {
    problems = validateJsonSchemaValue(definition.output.schema, value)
  } catch (error) {
    problems = [error.message]
  }
  check(label, problems.length === 0, problems.join('; '))
}

/** A temporary workspace per section. */
function workspace(name) {
  const root = mkdtempSync(join(tmpdir(), `wechat-${name}-`))
  return {
    root,
    batchesDir: join(root, 'batches'),
    exportDir: join(root, 'export'),
    databasePath: join(root, 'wechat.db'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/**
 * Build resolved options for a workspace.
 * @param space - A workspace.
 * @param overrides - Configuration overrides.
 * @returns the resolved options and the raw configuration.
 */
function optionsFor(space, overrides = {}) {
  const config = Config({
    batchesDir: space.batchesDir,
    databasePath: space.databasePath,
    exportDir: space.exportDir,
    exporterDir: '',
    keysFile: '',
    wechatDbParent: join(space.root, 'no-such-parent'),
    localTimeZone: 'Asia/Shanghai',
    ...overrides,
  })
  validate(config)
  return { config, options: resolveOptions(config) }
}

/**
 * Open a corpus and an importer for a workspace.
 * @param space - A workspace.
 * @param overrides - Configuration overrides.
 * @returns the store, importer, clock, and options.
 */
async function harness(space, overrides = {}) {
  const { options } = optionsFor(space, overrides)
  const clock = new LocalClock(options.timeZone)
  const store = await openStore({ path: options.databasePath })
  const importer = new WechatImporter({ store, options, clock })
  return { store, importer, clock, options }
}

/**
 * Mount the plugin the way the Loader does, with a stub context.
 *
 * `connection` is deliberately withheld so a later `provide` proves the settings
 * route appears when the Connection service mounts after this plugin.
 *
 * @param space - A workspace.
 * @param configOverrides - Configuration overrides.
 * @param mountOptions - Stub options.
 * @returns the mounted plugin, its tools, and the services it can still receive.
 */
async function mount(space, configOverrides = {}, mountOptions = {}) {
  const { config } = optionsFor(space, configOverrides)
  const tools = new Map()
  const routes = []
  const effects = []
  const services = new Map()
  const waiting = []
  let connection = null

  const contextFor = (extra = {}) => {
    const ctx = {
      logger: { warn: () => {}, info: () => {} },
      fiber: { entry: { options: { id: 'wechat' } } },
      get: (name) => (name === 'connection' ? connection : services.get(name)) ?? undefined,
      effect: (work, label) => {
        const promise = Promise.resolve().then(work)
        effects.push({ label, promise })
        return () => {}
      },
      inject: (names, callback) => {
        const satisfied = names.every((name) => (name === 'connection' ? connection !== null : services.has(name)))
        if (satisfied) {
          callback(contextFor(extra))
          return
        }
        waiting.push({ names, callback })
      },
      tools: { register: (tool) => tools.set(tool.name, tool) },
      ...(connection === null ? {} : { connection }),
      ...extra,
    }
    return ctx
  }

  for (const [name, value] of Object.entries(mountOptions.services ?? {})) services.set(name, value)
  await plugin.apply(contextFor(), config)
  await Promise.all(effects.map((effect) => effect.promise))
  return {
    tools,
    routes,
    config,
    effects,
    /** Publish the Connection service, as the Loader does once it settles. */
    async provideConnection() {
      connection = {
        fetch: {
          register: (route) => {
            routes.push(route)
            return () => {}
          },
        },
      }
      const pending = waiting.splice(0, waiting.length)
      for (const entry of pending) {
        if (entry.names.includes('connection')) entry.callback(contextFor())
      }
      await Promise.all(effects.map((effect) => effect.promise))
    },
    /** Publish another optional service. */
    provide(name, value) {
      services.set(name, value)
      const pending = waiting.splice(0, waiting.length)
      for (const entry of pending) {
        if (entry.names.every((service) => services.has(service))) entry.callback(contextFor())
      }
    },
    /** Release the plugin's effects, newest first. */
    async dispose() {
      for (const effect of [...effects].reverse()) {
        const teardown = await effect.promise
        if (typeof teardown === 'function') await teardown()
      }
    },
  }
}

// ── A. configuration and zone arithmetic ────────────────────────────────────

{
  const space = workspace('config')
  const { config } = optionsFor(space)
  check('A defaults resolve', resolveOptions(config).batchesDir === space.batchesDir)
  const derived = resolveOptions(Config({
    batchesDir: space.batchesDir,
    databasePath: space.databasePath,
    exporterDir: '/tmp/exporter',
  }))
  check('A export dir derives from the exporter', derived.exportDir === '/tmp/exporter/data', derived.exportDir)
  check('A keys file derives from the exporter', derived.keysFile === '/tmp/exporter/meta/wechat-keys.json', derived.keysFile)
  check('A lock file sits beside the corpus', derived.lockPath === join(space.root, 'import.lock'), derived.lockPath)

  const rejects = (label, overrides) => {
    let code = 'accepted'
    try {
      validate(Config({ batchesDir: space.batchesDir, databasePath: space.databasePath, ...overrides }))
    } catch (error) {
      code = error.message
    }
    check(label, code !== 'accepted', code.slice(0, 90))
  }
  rejects('A rejects a relative archive', { batchesDir: 'batches' })
  rejects('A rejects a relative corpus', { databasePath: 'wechat.db' })
  rejects('A rejects an unknown zone', { localTimeZone: 'Mars/Olympus' })
  rejects('A rejects a fractional import limit', { inlineImportLimit: 1.5 })

  const clock = new LocalClock('Asia/Shanghai')
  check('A reads a naive export time in the zone', clock.instantOf('2026-10-11T14:54:33') === Date.parse('2026-10-11T06:54:33Z'))
  check('A reads a date as local midnight', clock.instantOf('2026-10-11') === Date.parse('2026-10-10T16:00:00Z'))
  check('A honours an explicit offset', clock.instantOf('2026-10-11T14:54:33+02:00') === Date.parse('2026-10-11T12:54:33Z'))
  check('A rejects a non-time', clock.instantOf('yesterday') === null)
  check('A names the local day', clock.dayOf(Date.parse('2026-10-09T20:00:00Z')) === '2026-10-10')

  const newYork = new LocalClock('America/New_York')
  check(
    'A resolves a wall time before the spring change',
    newYork.instantOf('2026-03-08T01:30:00') === Date.parse('2026-03-08T06:30:00Z'),
    new Date(newYork.instantOf('2026-03-08T01:30:00')).toISOString(),
  )
  check(
    'A resolves a wall time after the spring change',
    newYork.instantOf('2026-03-08T03:30:00') === Date.parse('2026-03-08T07:30:00Z'),
    new Date(newYork.instantOf('2026-03-08T03:30:00')).toISOString(),
  )
  check(
    'A shifts a wall time the clock skips',
    newYork.instantOf('2026-03-08T02:30:00') === Date.parse('2026-03-08T07:30:00Z'),
    new Date(newYork.instantOf('2026-03-08T02:30:00')).toISOString(),
  )
  check(
    'A reads a repeated wall time as the earlier instant',
    newYork.instantOf('2026-11-01T01:30:00') === Date.parse('2026-11-01T05:30:00Z'),
    new Date(newYork.instantOf('2026-11-01T01:30:00')).toISOString(),
  )
  space.cleanup()
}

// ── B. import: counts, identity, enrichment, media ──────────────────────────

{
  const space = workspace('import')
  mkdirSync(space.batchesDir, { recursive: true })
  writeBatch(space.batchesDir)
  const { store, importer, clock, options } = await harness(space)

  const listed = importer.listBatches()
  check('B lists the batch as pending', listed.length === 1 && listed[0].state === 'pending', show(listed))
  check('B reads its declared size', listed[0].totalMessages === 10 && listed[0].chatCount === 2, show(listed[0]))

  const result = await importer.run({ batch: 'wechat-test-full' })
  check('B imports private messages', result.messages === 8, show(result))
  check('B skips group messages by default', result.groupSkipped === 2 && result.state === 'partial', show(result))
  check('B counts writes', result.generated === 8 && result.updated === 0 && result.unchanged === 0, show(result))
  check('B records the duplicate collision', result.collisions === 1, show(result))
  check('B reports no suspected replacement on a first import', result.suspectedReplacements === 0, show(result))
  check('B keeps the batch in place', result.dir === join(space.batchesDir, 'wechat-test-full') && result.copied === false)
  check('B numbers the files it read', result.files === 5, show(result.files))

  const stored = importer.listBatches()[0]
  check('B marks the batch partial after a private import', stored.state === 'partial', show(stored))
  check('B keeps the batch counters', stored.unchanged === 0 && stored.groupSkipped === 2, show(stored))

  const local = store.search({ query: 'local_id' })
  check('B gives a local id its own identity', store.item(local.rows[0].sourceId).identity === 'local_id', show(local.rows))
  const duplicates = store.search({ query: '重复的一条' })
  const indexes = duplicates.rows
    .map((row) => store.item(row.sourceId))
    .map((item) => item.duplicateIndex)
    .sort()
  check('B keeps both fingerprint duplicates', duplicates.total === 2 && indexes.join(',') === '0,1', show(indexes))

  const image = store.search({ kind: 'image' })
  const imageItem = store.item(image.rows[0].sourceId)
  check('B folds OCR text into the body', imageItem.content.includes('[OCR]') && imageItem.content.includes('发票'), show(imageItem.content))
  check(
    'B records the image reference',
    imageItem.media.length === 1 && imageItem.media[0].type === 'image' && /^[0-9a-f]{64}$/.test(imageItem.media[0].sha256),
    show(imageItem.media),
  )
  check('B resolves the image relative to its conversation', imageItem.media[0].path === 'Alice/images/123456.png', show(imageItem.media[0]))
  const voice = store.item(store.search({ kind: 'voice' }).rows[0].sourceId)
  check('B folds a voice transcription into the body', voice.content.includes('[语音转录]') && voice.content.includes('没问题'), show(voice.content))
  check('B records voice metadata', voice.media[0].type === 'voice' && voice.media[0].metadata.length === 3, show(voice.media))
  const quote = store.item(store.search({ kind: 'quote' }).rows[0].sourceId)
  check('B keeps the quoted message', quote.metadata.quote_content === '明天的会议改到三楼' || quote.metadata.quote_content === '明天的会议改到三点', show(quote.metadata.quote_content))
  check('B keeps the source location', quote.metadata.source_file === 'Alice.jsonl' && quote.metadata.source_line === 5, show(quote.metadata))

  const imported = await importer.run({ batch: 'wechat-test-full', includeGroups: true })
  check('B adds group messages on a second import', imported.messages === 10 && imported.generated === 2, show(imported))
  check('B marks the batch imported', imported.state === 'imported' && imported.groupSkipped === 0, show(imported))
  const again = await importer.run({ batch: 'wechat-test-full', includeGroups: true })
  check('B makes a re-import a no-op', again.generated === 0 && again.updated === 0 && again.unchanged === 10, show(again))
  check(
    'B does not call a batch\'s own duplicates replacements',
    again.suspectedReplacements === 0 && again.collisions === 1,
    show({ suspected: again.suspectedReplacements, collisions: again.collisions }),
  )
  check('B keeps one message per record', store.counts().messages === 10, show(store.counts()))

  const status = pipelineStatus({ store, options, clock, batches: importer.listBatches() })
  check('B reports the corpus totals', status.corpus.messages === 10 && status.corpus.chats === 2, show(status.corpus))
  check('B reports the import', status.import.batch === 'wechat-test-full' && status.import.status === 'ok', show(status.import))
  check('B reports no pending batch', status.batches.pending.length === 0 && status.batches.imported.length === 1, show(status.batches))

  // The same message arriving under a moved duplicate index is a replacement:
  // batch two repeats one record at its end, so that copy is filed second while
  // the corpus holds the same message first.
  const shifted = [...ALICE_RECORDS, ALICE_RECORDS[0]]
  writeBatch(space.batchesDir, { name: 'wechat-shifted', alice: shifted })
  const shiftResult = await importer.run({ batch: 'wechat-shifted', includeGroups: true })
  check(
    'B counts a message refiled under another identity',
    shiftResult.suspectedReplacements === 1,
    show({ suspected: shiftResult.suspectedReplacements, collisions: shiftResult.collisions, generated: shiftResult.generated }),
  )
  check('B keeps the earlier copy of a refiled message', shiftResult.generated > 0 && store.counts().messages > 10, show(store.counts()))

  // A file that changes after an import must be a loud failure, not a mixture.
  writeFileSync(join(result.dir, 'Alice.jsonl'), `${readFileSync(join(result.dir, 'Alice.jsonl'), 'utf8')}\n`)
  let changed = 'accepted'
  try {
    await importer.run({ batch: 'wechat-test-full', includeGroups: true })
  } catch (error) {
    changed = error.code
  }
  check('B refuses a batch whose content changed', changed === 'batch_changed', changed)
  store.close()
  space.cleanup()
}

// ── C. search, detail, and conversation aggregates ──────────────────────────

{
  const space = workspace('query')
  mkdirSync(space.batchesDir, { recursive: true })
  writeBatch(space.batchesDir)
  const { store, importer } = await harness(space)
  await importer.run({ batch: 'wechat-test-full', includeGroups: true })

  check('C matches message text', store.search({ query: '会议' }).total === 2, show(store.search({ query: '会议' }).total))
  check('C matches a sender id', store.search({ query: 'wxid_bob' }).total === 1, show(store.search({ query: 'wxid_bob' }).total))
  check('C matches by conversation name', store.search({ chat: '群聊' }).total === 2, show(store.search({ chat: '群聊' }).total))
  check('C filters by direction', store.search({ direction: 'outbound' }).total === 1, show(store.search({ direction: 'outbound' }).total))
  check('C filters by sender', store.search({ sender: 'Carol' }).total === 1)
  check('C matches nothing when nothing matches', store.search({ query: 'zzz-not-there' }).total === 0)

  const window = store.search({ since: 1791526400, until: 1791526401 })
  check('C honours a time window', window.total === 1 && window.rows[0].kind === 'text', show(window.rows.map((row) => row.ts)))
  const page = store.search({ limit: 3, offset: 0 })
  const second = store.search({ limit: 3, offset: 3 })
  check('C reports the full match count behind a page', page.total === 10 && page.rows.length === 3, show(page.total))
  check('C pages without repeating', second.rows[0].sourceId !== page.rows[0].sourceId)
  check('C orders newest first', page.rows[0].ts > page.rows[1].ts, show(page.rows.map((row) => row.ts)))

  const chats = store.chats()
  check('C aggregates per conversation', chats.length === 2, show(chats))
  const group = chats.find((row) => row.chatId === 'group-id')
  check('C counts a conversation', group.messageCount === 2 && group.activeDays === 1, show(group))
  check('C names a conversation from its newest message', group.name === '群聊A' && group.isGroup === true, show(group))
  store.close()
  space.cleanup()
}

// ── D. batch selection, refusals, and copying ───────────────────────────────

{
  const space = workspace('batches')
  mkdirSync(space.batchesDir, { recursive: true })
  mkdirSync(space.exportDir, { recursive: true })
  const { store, importer, clock, options } = await harness(space)

  for (const broken of brokenBatches()) {
    const overrides = {}
    if (Array.isArray(broken.alice)) overrides.alice = broken.alice
    if (Array.isArray(broken.group)) overrides.group = broken.group
    if (broken.mutate !== undefined && broken.alice === true) {
      overrides.alice = broken.mutate(ALICE_RECORDS.map((item) => ({ ...item })))
    }
    if (broken.meta !== undefined) overrides.meta = broken.meta
    if (broken.omitMeta === true) overrides.omitMeta = true
    if (broken.dropJsonl === true) overrides.dropJsonl = true
    if (broken.splitChat === true) overrides.splitChat = true
    const dir = writeBatch(space.batchesDir, { name: broken.name, ...overrides })
    let code = 'accepted'
    try {
      await importer.run({ batch: broken.name })
    } catch (error) {
      code = error.code
    }
    check(`D refuses ${broken.name} with ${broken.code}`, code === broken.code, code)
    rmSync(dir, { recursive: true, force: true })
  }

  const good = writeBatch(space.batchesDir, { name: 'wechat-good' })
  symlinkSync('/etc/passwd', join(good, 'link.jsonl'))
  let symlinkCode = 'accepted'
  try {
    await importer.run({ batch: 'wechat-good' })
  } catch (error) {
    symlinkCode = error.code
  }
  check('D refuses a batch holding a symlink', symlinkCode === 'batch_invalid', symlinkCode)
  rmSync(join(good, 'link.jsonl'), { force: true })

  let nameCode = 'accepted'
  try {
    validateImportIdGuard(importer)
  } catch (error) {
    nameCode = error.code
  }
  check('D refuses a path as a batch name', nameCode === 'unsupported_batch_name', nameCode)

  let missingCode = 'accepted'
  try {
    importer.plan({ source: join(space.root, 'nope') })
  } catch (error) {
    missingCode = error.code
  }
  check('D refuses a missing source', missingCode === 'source_missing', missingCode)

  // `latest` follows the exporter's own timestamps across sibling directories.
  writeBatch(space.exportDir, { name: 'older-batch', meta: { export_time: '2026-10-01T09:00:00' } })
  writeBatch(space.exportDir, { name: 'newer-batch', meta: { export_time: '2026-10-12T09:00:00' } })
  check('D picks the newest complete export', importer.plan({ source: 'latest' }).importId === 'newer-batch', show(importer.plan({ source: 'latest' })))

  // A same-named archived copy is older than the export `latest` chose. Falling
  // back to it would import different content than the caller asked for.
  writeBatch(space.batchesDir, { name: 'newer-batch', meta: { export_time: '2026-10-01T09:00:00' } })
  let shadowedCode = 'accepted'
  try {
    importer.plan({ source: 'latest' })
  } catch (error) {
    shadowedCode = error.code
  }
  check('D refuses latest when an archived batch shadows the export', shadowedCode === 'batch_exists', shadowedCode)
  rmSync(join(space.batchesDir, 'newer-batch'), { recursive: true, force: true })

  // A `--format text` run deletes the JSONL it wrote, leaving a directory the
  // exporter considers complete and this importer cannot read.
  const textOnly = writeBatch(space.exportDir, {
    name: 'text-only-batch',
    meta: { export_time: '2026-12-31T09:00:00' },
    dropJsonl: true,
  })
  check('D picks an importable export over a newer text-only one', importer.plan({ source: 'latest' }).importId === 'newer-batch', show(importer.plan({ source: 'latest' })))
  const withTextOnly = pipelineStatus({ store, options, clock, batches: importer.listBatches() })
  check(
    'D counts a text-only export apart from a broken one',
    withTextOnly.export.text_only_batches === 1 &&
      withTextOnly.export.invalid_batches === 0 &&
      withTextOnly.export.batch === 'newer-batch',
    show(withTextOnly.export),
  )
  check(
    'D reports a text-only export as a signal',
    withTextOnly.signals.some((signal) => signal.code === 'text_only_export' && signal.count === 1),
    show(withTextOnly.signals),
  )

  let textCode = 'accepted'
  try {
    await importer.run({ source: textOnly })
  } catch (error) {
    textCode = error.code
  }
  check('D refuses a text-only export with batch_invalid', textCode === 'batch_invalid', textCode)

  const archivedTextOnly = writeBatch(space.batchesDir, { name: 'wechat-textonly', dropJsonl: true })
  const listedTextOnly = importer.listBatches().find((row) => row.batch === 'wechat-textonly')
  check(
    'D lists an unreadable archive batch as invalid',
    listedTextOnly.state === 'invalid' && /jsonl/i.test(listedTextOnly.invalid ?? ''),
    show(listedTextOnly),
  )
  rmSync(archivedTextOnly, { recursive: true, force: true })

  const outside = writeBatch(space.root, { name: 'outside-batch' })
  const copied = await importer.run({ source: outside, copy: true })
  check('D copies an outside batch into the archive', copied.copied === true && copied.dir === join(space.batchesDir, 'outside-batch'), show(copied))
  check('D imports the copy', copied.messages === 8 && copied.outsideArchive === false, show(copied))
  let existsCode = 'accepted'
  try {
    await importer.run({ source: outside, copy: true })
  } catch (error) {
    existsCode = error.code
  }
  check('D refuses to overwrite an archived batch', existsCode === 'batch_exists', existsCode)

  const inPlace = await importer.run({ source: writeBatch(space.root, { name: 'wechat-in-place' }) })
  check('D imports an outside batch in place by default', inPlace.copied === false && inPlace.outsideArchive === true, show(inPlace))

  // A batch whose name is not a usable segment still imports under a derived one.
  const chinese = writeBatch(space.exportDir, { name: '群聊导出' })
  const derived = await importer.run({ source: chinese })
  check('D derives a batch name from the export time', /^wechat-\d{8}-\d{6}$/.test(derived.batch), show(derived.batch))

  // The lock is cross-process: a live holder's file must refuse a second import.
  writeFileSync(join(space.root, 'import.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
  const blocked = await importer.run({ batch: 'outside-batch' })
  check('D refuses while another process holds the lock', blocked.skipped === true && blocked.reason === 'busy', show(blocked))
  rmSync(join(space.root, 'import.lock'), { force: true })
  const stale = await importer.run({ batch: 'outside-batch' })
  check('D reclaims a lock whose process is gone', stale.ok === true, show(stale))

  // Deleting an old archive directory is safe: the stored batch row stays, the
  // listing skips a directory that is gone, and the messages remain.
  const kept = store.counts().messages
  rmSync(join(space.batchesDir, 'outside-batch'), { recursive: true, force: true })
  const afterRemoval = importer.listBatches()
  check(
    'D skips an archived batch whose directory is gone',
    !afterRemoval.some((row) => row.batch === 'outside-batch'),
    show(afterRemoval.map((row) => row.batch)),
  )
  const afterStatus = pipelineStatus({ store, options, clock, batches: afterRemoval })
  check(
    'D still probes a corpus whose batch directory is gone',
    afterStatus.ok === true && afterStatus.batches.total === afterRemoval.length && afterStatus.corpus.messages === kept,
    show({ total: afterStatus.batches.total, messages: afterStatus.corpus.messages }),
  )

  store.close()
  space.cleanup()
}

/**
 * Exercise the batch-name guard through the importer's public surface.
 * @param importer - The importer under test.
 */
function validateImportIdGuard(importer) {
  importer.plan({ batch: '../escape' })
}

// ── E. tools through the plugin, validated against their own schemas ─────────

{
  const space = workspace('tools')
  mkdirSync(space.batchesDir, { recursive: true })
  writeBatch(space.batchesDir, { name: 'wechat-tools' })
  mkdirSync(space.exportDir, { recursive: true })
  // Dated after this run, which is what an export written since the last import
  // looks like; the probe compares it against the stored import instant.
  writeBatch(space.exportDir, { name: 'wechat-exported', meta: { export_time: '2026-12-31T08:00:00' } })

  const mounted = await mount(space)
  const names = [...mounted.tools.keys()]
  check(
    'E registers seven tools',
    [
      'wechat_batches',
      'wechat_import',
      'wechat_search',
      'wechat_item',
      'wechat_chats',
      'wechat_status',
      'wechat_schedule',
    ].every((name) => names.includes(name)),
    show(names),
  )
  for (const tool of mounted.tools.values()) {
    assertSupportedJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.output.schema)
  }
  check('E declares supported schemas', true)

  const batches = mounted.tools.get('wechat_batches')
  const before = await batches.execute({}, {})
  accepts('E batches value satisfies its schema', batches, before)
  check('E lists the pending batch', before.batches.some((row) => row.batch === 'wechat-tools' && row.state === 'pending'), show(before.batches))
  check('E reports a pending batch as a state', before.state.pendingBatches === 1 && before.state.lastImportedAt === null, show(before.state))

  const importTool = mounted.tools.get('wechat_import')
  const imported = await importTool.execute({ batch: 'wechat-tools' }, {})
  accepts('E import value satisfies its schema', importTool, imported)
  check('E imports inline below the limit', imported.status === 'completed' && imported.messages === 8, show(imported))
  check('E the import tool is not concurrency-safe', importTool.isConcurrencySafe() === false)

  const cancelled = await importTool.execute({ batch: 'wechat-tools' }, { signal: AbortSignal.abort() })
  accepts('E cancelled value satisfies its schema', importTool, cancelled)
  check(
    'E an aborted call cancels the import before it writes',
    cancelled.ok === false && cancelled.reason.startsWith('cancelled'),
    show(cancelled),
  )

  const failed = await importTool.execute({ batch: 'not-a-batch' }, {})
  accepts('E failure value satisfies its schema', importTool, failed)
  check('E reports a missing batch as a value', failed.ok === false && failed.status === 'failed' && failed.reason.startsWith('batch_not_found'), show(failed))

  const search = mounted.tools.get('wechat_search')
  const found = await search.execute({ query: '会议' }, {})
  accepts('E search value satisfies its schema', search, found)
  check(
    'E search returns the message',
    found.total === 2 && found.items.some((row) => row.snippet.includes('会议')),
    show(found.items),
  )
  check('E search attaches freshness', found.state.pendingBatches === 0 && found.state.lastImportedAt !== null, show(found.state))
  const empty = await search.execute({ query: 'nothing-matches-this' }, {})
  accepts('E empty search value satisfies its schema', search, empty)

  const itemTool = mounted.tools.get('wechat_item')
  const item = await itemTool.execute({ id: found.items[0].id }, {})
  accepts('E item value satisfies its schema', itemTool, item)
  check('E item resolves its conversation', item.found === true && item.item.chatId === 'alice-id', show(item.item?.chatId))
  const missing = await itemTool.execute({ id: 'fallback:nope' }, {})
  accepts('E missing item value satisfies its schema', itemTool, missing)
  check('E reports a missing message as a value', missing.found === false && missing.item === null)

  const chats = mounted.tools.get('wechat_chats')
  const aggregates = await chats.execute({}, {})
  accepts('E chats value satisfies its schema', chats, aggregates)
  check('E aggregates one conversation', aggregates.chats.length === 1 && aggregates.chats[0].messageCount === 8, show(aggregates.chats))
  const filtered = await chats.execute({ chat: 'Alice' }, {})
  accepts('E filtered chats value satisfies its schema', chats, filtered)
  check('E narrows to the named conversation', filtered.chats.length === 1 && filtered.chats[0].chatId === 'alice-id', show(filtered.chats))

  const statusTool = mounted.tools.get('wechat_status')
  const status = await statusTool.execute({}, {})
  accepts('E status value satisfies its schema', statusTool, status)
  check('E reports the corpus', status.corpus.messages === 8 && status.corpus.chats === 1, show(status.corpus))
  check('E reports the imported archive', status.batches.imported.length === 1 && status.corpus.messages === 8, show(status.batches))

  const waiting = await statusTool.execute({}, {})
  accepts('E unimported-export value satisfies its schema', statusTool, waiting)
  check(
    'E points at an export nobody imported',
    waiting.signals.some((signal) => signal.code === 'unimported_export' && signal.batch === 'wechat-exported') &&
      waiting.status === 'import_pending',
    show(waiting.signals),
  )

  const direct = await importTool.execute({ source: 'latest' }, {})
  accepts('E latest-import value satisfies its schema', importTool, direct)
  check('E imports the newest export', direct.batch === 'wechat-exported', show(direct))
  const settled = await statusTool.execute({}, {})
  check(
    'E drops the signal once the export is in',
    !settled.signals.some((signal) => signal.code === 'unimported_export') && settled.status === 'ok',
    show(settled.signals),
  )

  // A batch above the inline limit becomes a job; the tool returns at once.
  const jobSpace = workspace('jobs')
  mkdirSync(jobSpace.batchesDir, { recursive: true })
  writeBatch(jobSpace.batchesDir, { name: 'wechat-big' })
  const started = []
  const jobs = {
    start: (job) => {
      started.push(job)
      return 'job-1'
    },
  }
  const withJobs = await mount(jobSpace, { inlineImportLimit: 0 }, { services: { jobs } })
  const big = await withJobs.tools.get('wechat_import').execute({ batch: 'wechat-big' }, { agent: { id: 'agent-1' } })
  accepts('E job value satisfies its schema', withJobs.tools.get('wechat_import'), big)
  check('E starts a job for a large batch', big.status === 'started' && big.jobId === 'job-1', show(big))
  check('E labels the job with the batch', started[0].label.includes('wechat-big') && started[0].kind === 'wechat-import', show(started[0].label))
  const progress = []
  const handle = started[0].run({ updateProgress: (message) => progress.push(message), append: () => {} })
  const finished = await handle.done
  check('E the job completes the import', finished.status === 'completed', show(finished))
  check('E the job reports progress', progress.length > 1, show(progress))

  await mounted.dispose()
  await withJobs.dispose()
  space.cleanup()
  jobSpace.cleanup()
}

// ── E2. an export written at the export directory root ─────────────────────

{
  const space = workspace('root-export')
  mkdirSync(space.batchesDir, { recursive: true })
  // The exporter's default output is the export directory itself, so the batch
  // has no directory name of its own.
  writeBatch(space.root, { name: 'export', meta: { export_time: '2026-12-31T08:00:00' } })
  const mounted = await mount(space)
  const statusTool = mounted.tools.get('wechat_status')
  const waiting = await statusTool.execute({}, {})
  check(
    'E2 reports an export written directly into the export directory',
    waiting.status === 'import_pending' &&
      waiting.signals.some((signal) => signal.code === 'unimported_export' && signal.batch === null),
    show(waiting.signals),
  )
  const imported = await mounted.tools.get('wechat_import').execute({ source: 'latest' }, {})
  check(
    'E2 imports the export at the export directory root',
    imported.ok === true && typeof imported.batch === 'string',
    show(imported),
  )
  await mounted.dispose()
  space.cleanup()
}

// ── E3. a narrower re-import keeps a full batch row ─────────────────────────

{
  const space = workspace('groups')
  mkdirSync(space.batchesDir, { recursive: true })
  writeBatch(space.batchesDir, { name: 'wechat-groups' })
  const mounted = await mount(space)
  const tool = mounted.tools.get('wechat_import')

  const grouped = await tool.execute({ batch: 'wechat-groups', includeGroups: true }, {})
  accepts('E2 grouped value satisfies its schema', tool, grouped)
  check(
    'E2 importing with groups stores the group messages',
    grouped.status === 'completed' && grouped.messages === 10 && grouped.state === 'imported',
    show(grouped),
  )
  const narrowed = await tool.execute({ batch: 'wechat-groups' }, {})
  check('E2 a narrower re-import succeeds', narrowed.status === 'completed', show(narrowed))
  const row = (await mounted.tools.get('wechat_batches').execute({}, {})).batches
    .find((entry) => entry.batch === 'wechat-groups')
  check(
    'E2 a narrower re-import keeps the full batch row',
    row?.state === 'imported' && row?.storedMessages === 10,
    show(row),
  )

  await mounted.dispose()
  space.cleanup()
}

// ── F. the settings bridge ──────────────────────────────────────────────────

{
  const space = workspace('bridge')
  mkdirSync(space.batchesDir, { recursive: true })
  writeBatch(space.batchesDir, { name: 'wechat-bridge' })
  const mounted = await mount(space)
  check('F waits for the connection service', mounted.routes.length === 0)
  await mounted.provideConnection()
  check('F registers the route once connection mounts', mounted.routes.length === 1 && mounted.routes[0].path === '/api/plugin-wechat', show(mounted.routes[0]?.path))

  const route = mounted.routes[0]
  const call = async (body, method = 'POST') => {
    const request = new Request('http://127.0.0.1:3080/api/plugin-wechat', {
      method,
      ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    })
    const response = await route.fetch(request)
    return { status: response.status, body: await response.json() }
  }

  const status = await call({ action: 'status' })
  check('F answers a status request', status.status === 200 && status.body.ok === true, show(status.body).slice(0, 120))
  check('F sends no message body to the page', !JSON.stringify(status.body).includes('会议'), show(status.body).slice(0, 160))
  check('F lists batches as state', status.body.value.batches.length === 1 && status.body.value.batches[0].state === 'pending', show(status.body.value.batches))
  check('F reports the resolved configuration', status.body.value.config.batchesDir === space.batchesDir)

  const started = await call({ action: 'import.start', batch: 'wechat-bridge' })
  check('F accepts an import request', started.status === 200 && started.body.value.started === true, show(started.body))
  await new Promise((resolve) => setTimeout(resolve, 200))
  const after = await call({ action: 'status' })
  check('F reports the finished import', after.body.value.import.lastResult?.ok === true, show(after.body.value.import.lastResult))

  const unknown = await call({ action: 'nope' })
  check('F refuses an unknown action', unknown.status === 400 && unknown.body.error.code === 'unknown_action', show(unknown.body))
  const broken = await call('{not json')
  check('F refuses a body that is not JSON', broken.status === 400 && broken.body.error.code === 'invalid_json', show(broken.body))
  const huge = await call(JSON.stringify({ action: 'status', pad: 'x'.repeat(40 * 1024) }))
  check('F refuses an oversized body', huge.status === 413 && huge.body.error.code === 'body_too_large', show(huge.body.error))

  await mounted.dispose()
  space.cleanup()
}

// ── F3. the page's schedule card ───────────────────────────────────────────

{
  const space = workspace('bridge-schedule')
  const mounted = await mount(space, { exporterDir: '/tmp/exporter' }, {
    // The page cannot name a Session, so the Host asks the harness for the
    // newest conversation; this stands in for the session controller.
    services: {
      sessionController: {
        list: async () => ({ items: [{ sessionId: 'session-page' }] }),
      },
    },
  })
  await mounted.provideConnection()
  const route = mounted.routes[0]
  const call = async (body) => {
    const response = await route.fetch(new Request('http://127.0.0.1:3080/api/plugin-wechat', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }

  const withoutService = await call({ action: 'status' })
  check(
    'F3 the status names a composition with no schedule service',
    withoutService.body.value.schedule.available === false,
    show(withoutService.body.value.schedule),
  )
  const ensureWithout = await call({ action: 'schedule.ensure' })
  check(
    'F3 setting up a task without a schedule service is a value, not a crash',
    ensureWithout.status === 200 && ensureWithout.body.value.status === 'unavailable',
    show(ensureWithout.body),
  )

  const made = []
  let nextId = 1
  mounted.provide('schedule', {
    catalog: async () => made.map((task) => ({ ...task, status: 'active', kind: 'cron', scheduledAt: '2026-11-02T01:00:00.000Z' })),
    create: async (sessionId, request) => {
      const task = { id: String(nextId), sessionId, ...request }
      nextId += 1
      made.push(task)
      return { ...task, scheduledAt: '2026-11-02T01:00:00.000Z' }
    },
    delete: async ({ id }) => {
      const index = made.findIndex((task) => task.id === id)
      if (index >= 0) made.splice(index, 1)
    },
  })

  const empty = await call({ action: 'status' })
  check(
    'F3 the card starts with no task and a working schedule service',
    empty.body.value.schedule.available === true && empty.body.value.schedule.tasks.length === 0,
    show(empty.body.value.schedule),
  )

  const created = await call({ action: 'schedule.ensure' })
  check(
    'F3 setting up binds the task to the newest conversation',
    created.status === 200 && created.body.value.status === 'created'
    && created.body.value.sessionId === 'session-page' && made.length === 1
    && made[0].sessionId === 'session-page',
    show({ value: created.body.value, sessions: made.map((task) => task.sessionId) }),
  )
  check(
    'F3 the answer carries the state the card renders next',
    created.body.value.schedule.active === true && created.body.value.schedule.tasks.length === 1,
    show(created.body.value.schedule),
  )

  const recreated = await call({ action: 'schedule.recreate' })
  check(
    'F3 rebuilding replaces the task rather than adding a second one',
    recreated.status === 200 && recreated.body.value.status === 'recreated'
    && made.length === 1 && made[0].id === '2'
    && recreated.body.value.nextRunAt === '2026-11-02T01:00:00.000Z',
    show({ ids: made.map((task) => task.id), next: recreated.body.value.nextRunAt }),
  )

  await mounted.dispose()
  space.cleanup()
}

// ── F1b. teardown waits for an accepted import ──────────────────────────────

{
  const space = workspace('teardown')
  mkdirSync(space.batchesDir, { recursive: true })
  writeBatch(space.batchesDir, { name: 'wechat-teardown' })
  const mounted = await mount(space)
  await mounted.provideConnection()
  const route = mounted.routes[0]
  const start = await route.fetch(new Request('http://127.0.0.1:3080/api/plugin-wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'import.start', batch: 'wechat-teardown' }),
  }))
  const started = await start.json()
  check('F1b accepts the import that teardown must wait for', started.value?.started === true, show(started))

  // Dispose while the import is between its validation and write phases. The
  // corpus must stay open until that import settles, or its staging write fails
  // and a re-run has to repair the corpus.
  await mounted.dispose()
  const after = await route.fetch(new Request('http://127.0.0.1:3080/api/plugin-wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'import.start', batch: 'wechat-teardown' }),
  }))
  const refused = await after.json()
  check('F1b refuses a new import once teardown began', refused.value?.reason === 'closing', show(refused))

  const store = await openStore({ path: space.databasePath })
  const counts = store.counts()
  store.close()
  check('F1b the accepted import finished before the corpus closed', counts.messages === 8, show(counts))
  space.cleanup()
}

// ── F2. the recurring import task ───────────────────────────────────────────

{
  const space = workspace('schedule')
  const mounted = await mount(space, { exporterDir: '/tmp/exporter' })
  const tool = mounted.tools.get('wechat_schedule')
  check('F2 the schedule tool is not concurrency-safe', tool.isConcurrencySafe() === false)
  const agent = { agent: { session: { id: 'session-1' } } }

  const withoutService = await tool.execute({}, agent)
  accepts('F2 unavailable value satisfies its schema', tool, withoutService)
  check(
    'F2 reports a composition with no schedule service',
    withoutService.status === 'unavailable' && withoutService.reason === 'schedule_unavailable',
    show(withoutService),
  )

  /** A schedule service that keeps what it is given, as the real one does. */
  const made = []
  let nextId = 1
  const schedule = {
    catalog: async () =>
      made.map((task) => ({ ...task, status: 'active', kind: 'cron', scheduledAt: '2026-10-19T01:00:00.000Z' })),
    create: async (sessionId, request) => {
      const task = { id: String(nextId), sessionId, ...request }
      nextId += 1
      made.push(task)
      return { ...task, scheduledAt: '2026-10-19T01:00:00.000Z' }
    },
    delete: async ({ id }) => {
      const index = made.findIndex((task) => task.id === id)
      if (index >= 0) made.splice(index, 1)
    },
  }
  mounted.provide('schedule', schedule)

  const noSession = await tool.execute({}, { agent: {} })
  accepts('F2 sessionless value satisfies its schema', tool, noSession)
  check('F2 refuses to guess a conversation', noSession.status === 'unavailable' && noSession.reason === 'no_session', show(noSession))

  const created = await tool.execute({}, agent)
  accepts('F2 created value satisfies its schema', tool, created)
  check('F2 creates the task', created.status === 'created' && created.taskId === '1' && made.length === 1, show(created))
  check('F2 names the task and its next run', created.nextRunAt === '2026-10-19T01:00:00.000Z' && made[0].title === '微信数据导入', show(made[0]))
  check(
    'F2 schedules the configured recurrence in the configured zone',
    made[0].cron.expression === '0 9 * * 1' && made[0].cron.time_zone === 'Asia/Shanghai',
    show(made[0].cron),
  )
  const prompt = made[0].prompt
  check(
    'F2 writes the export and import steps into the prompt',
    prompt.includes('[dsh-wechat:auto-import]') &&
      prompt.includes('cd /tmp/exporter && .venv/bin/python export.py --format jsonl --days 7') &&
      prompt.includes(`${space.batchesDir}/wechat-$(date +%Y%m%d-%H%M%S)`) &&
      prompt.includes('wechat_import'),
    show(prompt),
  )

  const again = await tool.execute({}, agent)
  check('F2 keeps an existing task', again.status === 'exists' && made.length === 1 && again.taskId === '1', show(again))

  const recreated = await tool.execute({ recreate: true }, agent)
  accepts('F2 recreated value satisfies its schema', tool, recreated)
  check('F2 replaces the task on request', recreated.status === 'recreated' && made.length === 1 && made[0].id === '2', show(made.map((task) => task.id)))

  // A replacement that cannot be created must leave the working task alone, or
  // a transient schedule failure would silently remove the automation.
  const createTask = schedule.create
  schedule.create = async () => {
    throw Object.assign(new Error('refused'), { code: 'invalid_cron' })
  }
  const failedRecreate = await tool.execute({ recreate: true }, agent)
  schedule.create = createTask
  accepts('F2 failed recreated value satisfies its schema', tool, failedRecreate)
  check(
    'F2 keeps the working task when the replacement cannot be created',
    failedRecreate.status === 'failed' && made.length === 1 && made[0].id === '2',
    show({ status: failedRecreate.status, ids: made.map((task) => task.id) }),
  )

  // A task the user made by hand through the harness schedule is adopted, not
  // duplicated, because the marker is what identifies it.
  made.length = 0
  made.push({ id: '9', sessionId: 'session-9', title: 'renamed by hand', prompt: 'x [dsh-wechat:auto-import] y', cron: {} })
  const adopted = await tool.execute({}, agent)
  check('F2 adopts a marked task it did not create', adopted.status === 'exists' && adopted.taskId === '9' && made.length === 1, show(adopted))

  // With no exporter configured, the task asks instead of inventing a command.
  const bare = workspace('schedule-none')
  const bareMount = await mount(bare)
  const bareMade = []
  bareMount.provide('schedule', {
    catalog: async () => bareMade.map((task) => ({ ...task, status: 'active', kind: 'cron', scheduledAt: null })),
    create: async (sessionId, request) => {
      const task = { id: '1', sessionId, ...request }
      bareMade.push(task)
      return { ...task, scheduledAt: null }
    },
    delete: async () => {},
  })
  await bareMount.tools.get('wechat_schedule').execute({}, agent)
  check(
    'F2 asks the user to export when no exporter is configured',
    bareMade.length === 1 && bareMade[0].prompt.includes('Ask the user to run their WeChat exporter'),
    show(bareMade[0]?.prompt),
  )
  await bareMount.dispose()
  bare.cleanup()

  await mounted.dispose()
  space.cleanup()
}

// ── G. the status probe against a machine-shaped fixture ────────────────────

{
  const space = workspace('status')
  mkdirSync(space.batchesDir, { recursive: true })
  const account = join(space.root, 'xwechat_files', 'wxid_demo')
  mkdirSync(join(account, 'db_storage', 'message'), { recursive: true })
  writeFileSync(join(account, 'db_storage', 'message', 'message_0.db'), 'shard')
  writeFileSync(join(account, 'db_storage', 'message', 'message_0.db-wal'), 'wal')
  writeFileSync(join(account, 'db_storage', 'message', 'message_0.db-shm'), 'shm')
  writeFileSync(join(account, 'db_storage', 'message', 'message_1.db'), 'shard')
  const metaDir = join(space.root, 'exporter', 'meta')
  mkdirSync(metaDir, { recursive: true })
  const keysFile = join(metaDir, 'wechat-keys.json')
  writeFileSync(keysFile, JSON.stringify({ message_0: 'SECRET-A', message_1: 'SECRET-B', contact: 'SECRET-C' }))

  const { store, importer, clock, options } = await harness(space, {
    wechatDbParent: join(space.root, 'xwechat_files'),
    keysFile,
  })
  const status = pipelineStatus({ store, options, clock, batches: importer.listBatches() })
  check('G finds the account database', status.database.status === 'ok' && status.database.shard_count === 2, show(status.database))
  check('G ignores the shared-memory file', status.database.shards.join(',') === 'message_0.db,message_1.db', show(status.database.shards))
  check('G reads key names only', status.keys.status === 'ok' && status.keys.message_keys.length === 2 && status.keys.contact_key === true, show(status.keys))
  check('G never echoes a key value', !JSON.stringify(status).includes('SECRET'), 'value leaked')
  check('G reports the coverage gap', status.keys.message_shards_covered === 2 && status.keys.message_shards_total === 2, show(status.keys))

  writeFileSync(keysFile, JSON.stringify({ message_0: 'SECRET-A' }))
  const partial = pipelineStatus({ store, options, clock, batches: importer.listBatches() })
  check('G signals incomplete key coverage', partial.keys.message_shards_covered === 1, show(partial.keys))
  check('G calls incomplete coverage a notice', partial.status === 'notice', show(partial.status))
  check('G lists the coverage signal', partial.signals.some((signal) => signal.code === 'keys_incomplete'), show(partial.signals))

  writeFileSync(keysFile, '{not json')
  const invalid = pipelineStatus({ store, options, clock, batches: importer.listBatches() })
  check('G reports an unreadable key file as invalid', invalid.keys.status === 'invalid', show(invalid.keys))
  check('G demands action for an invalid key file', invalid.status === 'action_required', show(invalid.status))

  mkdirSync(join(space.root, 'xwechat_files', 'wxid_second', 'db_storage'), { recursive: true })
  const ambiguous = pipelineStatus({ store, options, clock, batches: importer.listBatches() })
  check('G reports two accounts as ambiguous', ambiguous.database.status === 'ambiguous', show(ambiguous.database))

  rmSync(keysFile, { force: true })
  const missing = pipelineStatus({ store, options, clock, batches: importer.listBatches() })
  check('G reports a missing key file', missing.keys.status === 'missing' && missing.signals.some((signal) => signal.code === 'keys_missing'), show(missing.signals))

  store.close()
  space.cleanup()
}

// ── H. an empty workspace is a valid, explained state ───────────────────────

{
  const space = workspace('empty')
  const { store, importer, clock, options } = await harness(space)
  const status = pipelineStatus({ store, options, clock, batches: importer.listBatches() })
  check('H reports an empty corpus', status.corpus.messages === 0 && status.corpus.chats === 0, show(status.corpus))
  check('H reports an empty archive', status.batches.status === 'empty' && status.batches.total === 0, show(status.batches))
  check('H reports no import', status.import.status === 'none' && status.import.last_success_at === null, show(status.import))
  check('H names its exporter directory state', status.export.status === 'ok' || status.export.status === 'not_found', show(status.export.status))

  // The only thing wrong is an export this importer cannot read, which on its
  // own is a notice rather than a demand for action.
  writeBatch(space.exportDir, { name: 'wechat-textonly', dropJsonl: true })
  const textOnly = pipelineStatus({ store, options, clock, batches: importer.listBatches() })
  check(
    'H makes a text-only export a notice',
    textOnly.status === 'notice' && textOnly.export.batch === null && textOnly.export.text_only_batches === 1,
    show(textOnly),
  )
  store.close()
  space.cleanup()
}

// ── J. an existing corpus file is made owner-only ───────────────────────────

{
  const directory = mkdtempSync(join(tmpdir(), 'wechat-mode-'))
  const path = join(directory, 'corpus.db')
  writeFileSync(path, '')
  chmodSync(path, 0o644)
  const store = await openStore({ path })
  store.close()
  const mode = statSync(path).mode & 0o777
  check('J an existing corpus file is tightened to 0600', mode === 0o600, mode.toString(8))
  rmSync(directory, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? 'all checks passed' : `${failures.length} check(s) failed`}`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
