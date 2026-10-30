/**
 * The import pipeline: pick a batch, validate it whole, then write it.
 *
 * The order is what makes an import safe to repeat. The batch is parsed and
 * checked end to end — every record, every count against `export_meta`, every
 * media reference — before a single message is written; only then do the
 * messages land, one conversation per transaction. A crash or a database error
 * part-way therefore leaves a corpus that a re-run converges, because every
 * already-written message deduplicates to a no-op.
 *
 * yorha committed items and its manifest in one transaction and deleted the
 * batch afterwards. Neither behaviour is kept: batches are the durable raw
 * record here, and holding one transaction open across a large batch parse would
 * block every read while it runs.
 *
 * @module dsh-wechat/src/importer
 */

import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { errorCode, fail, WechatError } from './errors.js'
import { deriveImportId, parseBatch, readExportSummary, readSourceFiles, validateImportId } from './parser.js'

/** Messages buffered before a chunk is written. */
const CHUNK = 1000

/**
 * Import one batch at a time, in this process and across processes.
 *
 * The in-process half is a boolean; the cross-process half is a lock file beside
 * the corpus, so a second Harness sharing this home directory refuses instead of
 * interleaving two imports of the same messages.
 */
export class WechatImporter {
  #store
  #options
  #clock
  #logger
  #running = false
  #progress = null
  #chain = Promise.resolve()
  #inFlight = null
  #closed = false

  /**
   * @param options - Construction options.
   * @param options.store - The open corpus.
   * @param options.options - Resolved plugin options.
   * @param options.clock - The zone-bound clock.
   * @param options.logger - Plugin logger.
   */
  constructor({ store, options, clock, logger }) {
    this.#store = store
    this.#options = options
    this.#clock = clock
    this.#logger = logger
  }

  /** @returns whether an import is in flight. */
  get busy() {
    return this.#running
  }

  /** @returns the last progress event, or null. */
  get progress() {
    return this.#progress
  }

  /** @returns whether this importer has stopped accepting work. */
  get closed() {
    return this.#closed
  }

  /**
   * Stop accepting new imports. A queued import that has not started yet is
   * refused; one already running is allowed to finish, and {@link drained}
   * waits for it.
   */
  dispose() {
    this.#closed = true
  }

  /**
   * Resolve once every accepted import settled.
   *
   * Teardown uses this so the corpus is never closed under a running import.
   * The loop also covers work a page request enqueued while the previous
   * import was finishing.
   */
  async drained() {
    for (;;) {
      const chain = this.#chain
      await chain.catch(() => {})
      const inFlight = this.#inFlight
      if (inFlight !== null) {
        await inFlight.catch(() => {})
        continue
      }
      if (chain === this.#chain) return
    }
  }

  /**
   * What the batch list can say without walking a batch.
   * @returns one row per directory in the archive root, newest first.
   */
  listBatches() {
    const rows = []
    let entries = []
    try {
      entries = readdirSync(this.#options.batchesDir)
    } catch (error) {
      // A missing archive root is an empty archive, not a failure: the first
      // import creates it.
      if (error.code !== 'ENOENT') this.#logger?.warn?.(`wechat: reading the archive root failed: ${String(error)}`)
      entries = []
    }
    for (const name of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) continue
      const dir = join(this.#options.batchesDir, name)
      let stat
      try {
        stat = statSync(dir)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      const summary = readExportSummary(dir, this.#clock)
      const stored = this.#store.batch(name)
      const readable = summary.ok && summary.jsonlFiles > 0
      rows.push({
        batch: name,
        dir,
        state: stored === undefined ? (readable ? 'pending' : summary.ok ? 'invalid' : summary.reason) : stored.state,
        exportTime: summary.ok ? summary.exportTime : null,
        exportInstant: summary.ok ? summary.exportInstant : null,
        chatCount: summary.ok ? summary.chatCount : null,
        totalMessages: summary.ok ? summary.totalMessages : null,
        invalid: summary.ok
          ? readable
            ? null
            : 'holds no JSONL: the exporter ran without --format jsonl'
          : summary.message,
        importedAt: stored?.imported_at ?? null,
        includeGroups: stored === undefined ? null : Number(stored.include_groups) === 1,
        messages: stored?.total_messages ?? null,
        storedMessages: stored === undefined ? null : Number(stored.total_messages) - Number(stored.group_skipped),
        generated: stored?.generated ?? null,
        updated: stored?.updated ?? null,
        unchanged: stored?.unchanged ?? null,
        groupSkipped: stored?.group_skipped ?? null,
        collisions: stored?.collisions ?? null,
        suspectedReplacements: stored?.suspected_replacements ?? null,
      })
    }
    rows.sort(compareBatches)
    return rows
  }

  /**
   * Resolve what would be imported, without importing or copying anything.
   *
   * The tool uses this to decide whether an import is small enough to run inside
   * the call, and the plugin page uses it to show what a name refers to.
   *
   * @param request - What to import.
   * @param request.batch - A batch name inside the archive root.
   * @param request.source - `latest`, or an absolute path to a batch directory.
   * @returns the resolved target, including the message count a batch declares.
   */
  plan(request = {}) {
    return this.#resolve(request)
  }

  /**
   * Import one batch.
   *
   * @param request - What to import.
   * @param request.batch - A batch name inside the archive root.
   * @param request.source - `latest`, or an absolute path to a batch directory.
   * @param request.copy - Move a copy into the archive root before importing.
   * @param request.includeGroups - Import group messages too.
   * @param request.onProgress - Called with `{phase, message, processed, total}`.
   * @param request.signal - Cancellation signal, checked between conversations.
   * @returns the import result, or `{skipped: true, reason}` when another import holds the lock.
   */
  run(request = {}) {
    if (this.#closed) return Promise.resolve({ skipped: true, reason: 'closed' })
    const running = this.#run(request)
    this.#inFlight = running
    void running
      .finally(() => {
        if (this.#inFlight === running) this.#inFlight = null
      })
      .catch(() => {})
    return running
  }

  /**
   * Import one batch after admission.
   * @param request - What to import.
   * @param request.batch - A batch name inside the archive root.
   * @param request.source - `latest`, or an absolute path to a batch directory.
   * @param request.copy - Move a copy into the archive root before importing.
   * @param request.includeGroups - Import group messages too.
   * @param request.onProgress - Called with `{phase, message, processed, total}`.
   * @param request.signal - Cancellation signal, checked between conversations.
   * @returns the import result, or `{skipped: true, reason}` when another import holds the lock.
   */
  async #run({ batch, source, copy = false, includeGroups, onProgress, signal } = {}) {
    if (this.#running) return { skipped: true, reason: 'busy' }
    const scope = includeGroups === undefined ? this.#options.includeGroups : includeGroups === true
    const lock = acquireLock(this.#options.lockPath, this.#logger)
    if (!lock.acquired) return { skipped: true, reason: 'busy', holder: lock.holder }
    this.#running = true
    const startedAt = Date.now()
    const report = (phase, message, processed = null, total = null) => {
      this.#progress = { phase, message, processed, total, at: this.#clock.nowIso() }
      onProgress?.(this.#progress)
    }
    try {
      throwIfAborted(signal)
      const planned = this.#resolve({ batch, source })
      const target = copy === true && planned.outsideArchive ? this.#copyIntoArchive(planned) : planned
      throwIfAborted(signal)
      report('reading', `reading ${target.importId}`, 0, null)
      const inventory = readSourceFiles(target.dir)
      throwIfAborted(signal)
      const stored = this.#store.batch(target.importId)
      if (stored !== undefined && stored.source_files_hash !== inventory.digest) {
        fail(
          'batch_changed',
          `batch ${target.importId} was imported from different content; import it under another name or start a fresh corpus`,
        )
      }

      // Pass one: validate the whole batch and stage its identities. Nothing is
      // written to the corpus until every count agrees with export_meta.
      this.#store.openStaging()
      let staged = []
      const flushStaged = () => {
        if (staged.length === 0) return
        const chunk = staged
        staged = []
        this.#store.transaction(() => {
          for (const item of chunk) this.#store.stageItem(item)
        })
      }
      const summary = await parseBatch({
        root: target.dir,
        importId: target.importId,
        clock: this.#clock,
        includeGroups: scope,
        files: inventory.files,
        onProgress: (event) => report('validating', 'validating messages', event.processed, null),
        onRecord: (record) => {
          // Validation is the expensive pass on a large batch; check the
          // caller's cancellation per record so a cancelled job does not hash
          // and stage the whole archive first.
          throwIfAborted(signal)
          // Only the identity is staged: the whole batch never sits in memory.
          staged.push({
            sourceId: record.sourceId,
            fallbackBase: record.fallbackBase,
            contentHash: record.contentHash,
            importId: record.importId,
          })
          if (staged.length >= CHUNK) flushStaged()
        },
      })
      flushStaged()
      throwIfAborted(signal)
      const suspected = this.#store.suspectedReplacements()

      // Pass two: write the messages, one conversation per transaction.
      const nowIso = this.#clock.nowIso()
      const counts = { generated: 0, updated: 0, unchanged: 0 }
      const touched = new Set()
      let written = 0
      let pending = []
      const flushWritten = () => {
        if (pending.length === 0) return
        const chunk = pending
        pending = []
        const result = this.#store.transaction(() => this.#store.writeChunk(chunk, nowIso))
        counts.generated += result.generated
        counts.updated += result.updated
        counts.unchanged += result.unchanged
        for (const chatId of result.touched) touched.add(chatId)
      }
      await parseBatch({
        root: target.dir,
        importId: target.importId,
        clock: this.#clock,
        includeGroups: scope,
        files: inventory.files,
        onProgress: (event) => report('writing', 'writing messages', event.processed, summary.collected),
        onRecord: (record) => {
          pending.push(record)
          written += 1
          if (pending.length >= CHUNK) {
            flushWritten()
            report('writing', 'writing messages', written, summary.collected)
            throwIfAborted(signal)
          }
        },
      })
      flushWritten()

      // Re-importing a batch that already landed with group messages under a
      // narrower scope adds nothing and must not rewrite its row as `partial`
      // with the private-only counts.
      const alreadyFull = stored !== undefined && stored.include_groups === 1 && !scope && summary.groupRecords > 0
      const state = alreadyFull
        ? (stored.state === 'imported' ? 'imported' : stored.state)
        : (scope || summary.groupRecords === 0) ? 'imported' : 'partial'
      const row = batchRow({ target, summary, counts, suspected, state, scope, nowIso })
      this.#store.transaction(() => {
        // The derived conversation rows move with the messages they summarize.
        this.#store.refreshChats([...touched], nowIso)
        if (!alreadyFull) this.#store.putBatch(row)
        this.#store.setMeta('last_import_at', nowIso)
        this.#store.setMeta('last_error_code', '')
      })
      report('done', `imported ${summary.collected} messages`, summary.collected, summary.collected)
      return {
        ok: true,
        status: 'completed',
        batch: target.importId,
        dir: target.dir,
        copied: target.copied,
        outsideArchive: target.outsideArchive,
        firstImport: stored === undefined,
        files: summary.files.length,
        bytes: summary.bytes,
        messages: summary.collected,
        groupSkipped: summary.skipped,
        collisions: summary.collisions,
        suspectedReplacements: suspected,
        includeGroups: scope,
        state,
        exportTime: summary.exportMeta.export_time,
        zoneAssumed: summary.zoneAssumed,
        chatCount: summary.exportMeta.chat_count,
        totalMessages: summary.exportMeta.total_messages,
        elapsedMs: Date.now() - startedAt,
        ...counts,
      }
    } catch (error) {
      // A cancellation is the caller's own decision, not a failed import, so it
      // must not mark the corpus as needing attention.
      if (error?.code !== 'cancelled') this.#recordFailure(error)
      throw error
    } finally {
      try {
        if (this.#store.staging) this.#store.closeStaging()
      } catch (closeError) {
        this.#logger?.warn?.(`wechat: dropping the staging table failed: ${String(closeError)}`)
      }
      this.#running = false
      lock.release()
    }
  }

  /**
   * Serialize imports within this process.
   *
   * A second caller waits for the first instead of racing it, which is what the
   * plugin page needs: two clicks on 导入 must not both start work.
   *
   * @param work - Called once the previous import settled.
   * @returns whatever `work` returned.
   */
  queue(work) {
    const next = this.#chain.then(work, work)
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * Resolve what to import into a concrete directory and batch name.
   * @param request - The caller's request.
   * @param request.batch - Batch name inside the archive root.
   * @param request.source - `latest`, or an absolute path.
   * @returns the resolved target.
   */
  #resolve({ batch, source }) {
    if (typeof batch === 'string' && batch.trim() !== '') {
      if (typeof source === 'string' && source.trim() !== '') {
        fail('batch_not_found', 'pass either a batch name or a source path, not both')
      }
      const importId = batch.trim()
      validateImportId(importId)
      const dir = join(this.#options.batchesDir, importId)
      const summary = readExportSummary(dir, this.#clock)
      if (!summary.ok) {
        if (summary.reason === 'incomplete') {
          if (!existsSync(dir)) fail('batch_not_found', `no batch named ${importId} in ${this.#options.batchesDir}`)
          fail('batch_incomplete', `${dir} has no export_meta.json yet: the exporter writes it last`)
        }
        fail('batch_invalid', `${dir} cannot be imported: ${summary.message}`)
      }
      return {
        importId,
        dir,
        copied: false,
        outsideArchive: false,
        totalMessages: summary.totalMessages,
        exportTime: summary.exportTime,
      }
    }
    const requested = typeof source === 'string' && source.trim() !== '' ? source.trim() : 'latest'
    if (requested === 'latest') return this.#resolveLatest()
    const dir = resolve(requested)
    let stat
    try {
      stat = statSync(dir)
    } catch {
      fail('source_missing', `the source directory does not exist: ${dir}`)
    }
    if (!stat.isDirectory()) fail('source_missing', `the source is not a directory: ${dir}`)
    const summary = readExportSummary(dir, this.#clock)
    if (!summary.ok) {
      if (summary.reason === 'incomplete') fail('batch_incomplete', `${dir} has no export_meta.json yet`)
      fail('batch_invalid', `${dir} cannot be imported: ${summary.message}`)
    }
    const name = basename(dir)
    const insideArchive = dirname(dir) === resolve(this.#options.batchesDir)
    let importId
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && name !== '.' && name !== '..') {
      importId = name
    } else {
      importId = deriveImportId(this.#clock, summary.exportInstant ?? Date.now())
    }
    return {
      importId,
      dir,
      copied: false,
      outsideArchive: !insideArchive,
      totalMessages: summary.totalMessages,
      exportTime: summary.exportTime,
    }
  }

  /**
   * Copy an outside batch into the archive root under its resolved name.
   *
   * The copy lands at a hidden sibling first and is renamed into place, so an
   * interrupted copy never looks like a complete batch to the next listing.
   *
   * @param planned - A resolved target outside the archive root.
   * @returns the target inside the archive root.
   */
  #copyIntoArchive(planned) {
    const destination = join(this.#options.batchesDir, planned.importId)
    if (existsSync(destination)) {
      fail('batch_exists', `${destination} already exists; import it by name, or pass another name`)
    }
    const incoming = join(this.#options.batchesDir, `.${planned.importId}.incoming`)
    rmSync(incoming, { recursive: true, force: true })
    try {
      cpSync(planned.dir, incoming, { recursive: true, errorOnExist: true, force: false, dereference: false })
      renameSync(incoming, destination)
    } catch (error) {
      rmSync(incoming, { recursive: true, force: true })
      fail('copy_failed', `copying ${planned.dir} into the archive failed: ${error.message}`)
    }
    return { ...planned, dir: destination, copied: true, outsideArchive: false }
  }

  /**
   * Find the newest complete batch the exporter wrote.
   * @returns the resolved target.
   */
  #resolveLatest() {
    const exportDir = this.#options.exportDir
    if (exportDir === '') {
      fail(
        'batch_not_found',
        'no exporter directory is configured, so there is nothing to pick the latest batch from; pass a batch name or an absolute path',
      )
    }
    const candidates = []
    const consider = (dir) => {
      const summary = readExportSummary(dir, this.#clock)
      if (!summary.ok) return
      const name = basename(dir)
      const usable = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && name !== '.' && name !== '..'
      const importId = dir === exportDir || !usable
        ? deriveImportId(this.#clock, summary.exportInstant ?? Date.now())
        : name
      candidates.push({
        dir,
        importId,
        instant: summary.exportInstant ?? 0,
        importable: summary.jsonlFiles > 0,
        totalMessages: summary.totalMessages,
        exportTime: summary.exportTime,
      })
    }
    if (existsSync(exportDir)) {
      consider(exportDir)
      for (const name of readdirSync(exportDir)) {
        const dir = join(exportDir, name)
        try {
          if (!statSync(dir).isDirectory()) continue
        } catch (error) {
          if (error.code !== 'ENOENT') this.#logger?.warn?.(`wechat: inspecting ${dir} failed: ${String(error)}`)
          continue
        }
        consider(dir)
      }
    }
    if (candidates.length === 0) {
      fail('batch_not_found', `no complete batch was found in ${exportDir}`)
    }
    // A text-only export is complete but holds nothing to import, so it is only
    // ever chosen when it is the only candidate — and then the import names the
    // directory it could not read.
    candidates.sort(
      (left, right) =>
        Number(right.importable) - Number(left.importable) ||
        right.instant - left.instant ||
        (left.importId < right.importId ? 1 : -1),
    )
    const chosen = candidates[0]
    const archived = join(this.#options.batchesDir, chosen.importId)
    if (existsSync(archived) && resolve(archived) !== resolve(chosen.dir)) {
      // The newest export has the same name as a batch already in the archive.
      // Picking the archived copy would silently import older content than the
      // caller asked for, so name the collision instead.
      fail(
        'batch_exists',
        `the newest export "${chosen.importId}" has the same name as an archived batch; import the archived copy by name if that is the one you mean, or rename the export`,
      )
    }
    if (existsSync(archived)) {
      return {
        importId: chosen.importId,
        dir: archived,
        copied: false,
        outsideArchive: false,
        totalMessages: chosen.totalMessages,
        exportTime: chosen.exportTime,
      }
    }
    return {
      importId: chosen.importId,
      dir: chosen.dir,
      copied: false,
      outsideArchive: true,
      totalMessages: chosen.totalMessages,
      exportTime: chosen.exportTime,
    }
  }

  /**
   * Record a failed attempt without touching the messages a re-run will repair.
   * @param error - The thrown value.
   */
  #recordFailure(error) {
    const code = errorCode(error)
    try {
      this.#store.transaction(() => {
        this.#store.setMeta('last_error_code', code)
      })
    } catch (recordError) {
      this.#logger?.warn?.(`wechat: recording import failure ${code} also failed: ${String(recordError)}`)
    }
  }
}

/**
 * The batch row for one finished import.
 * @param options - Row inputs.
 * @param options.target - Resolved batch target.
 * @param options.summary - Parse summary.
 * @param options.counts - Write counts.
 * @param options.suspected - Suspected replacement count.
 * @param options.state - `imported` or `partial`.
 * @param options.scope - Whether group messages were imported.
 * @param options.nowIso - Instant of this import.
 * @returns every batch column.
 */
function batchRow({ target, summary, counts, suspected, state, scope, nowIso }) {
  const meta = summary.exportMeta
  return {
    import_id: target.importId,
    dir: target.dir,
    export_time: meta.export_time,
    total_messages: meta.total_messages,
    include_groups: scope,
    state,
    imported_at: nowIso,
    generated: counts.generated,
    updated: counts.updated,
    unchanged: counts.unchanged,
    group_skipped: summary.skipped,
    collisions: summary.collisions,
    suspected_replacements: suspected,
    source_files_hash: summary.digest,
  }
}

/**
 * Order batches for display: newest export first, then by name.
 * @param left - First batch row.
 * @param right - Second batch row.
 * @returns the comparator result.
 */
function compareBatches(left, right) {
  const leftInstant = left.exportInstant ?? 0
  const rightInstant = right.exportInstant ?? 0
  if (leftInstant !== rightInstant) return rightInstant - leftInstant
  return left.batch < right.batch ? -1 : 1
}

/**
 * Throw when the caller asked to stop.
 * @param signal - Cancellation signal, when the caller passed one.
 */
function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw new WechatError('cancelled', 'the import was cancelled')
  }
}

/**
 * Take the cross-process import lock.
 *
 * A lock whose process is gone is reclaimed: a crashed Harness must not be able
 * to block every later import.
 *
 * @param path - Lock file path.
 * @param logger - Plugin logger.
 * @returns whether the lock was taken, and who holds it when it was not.
 */
function acquireLock(path, logger) {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, payload, { flag: 'wx', mode: 0o600 })
      return {
        acquired: true,
        release: () => {
          try {
            unlinkSync(path)
          } catch (error) {
            logger?.warn?.(`wechat: releasing the import lock failed: ${String(error)}`)
          }
        },
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw new WechatError('db_unavailable', `could not take the import lock: ${error.message}`)
    }
    const holder = readLockHolder(path)
    if (holder !== null && processAlive(holder.pid)) return { acquired: false, holder }
    if (attempt === 0) {
      try {
        unlinkSync(path)
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') {
          logger?.warn?.(`wechat: clearing a stale import lock failed: ${String(unlinkError)}`)
          return { acquired: false, holder }
        }
      }
    }
  }
  return { acquired: false, holder: readLockHolder(path) }
}

/**
 * Read the lock file's holder.
 * @param path - Lock file path.
 * @returns the holder, or null when the file is gone or unreadable.
 */
function readLockHolder(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed?.pid === 'number' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Whether a process id is still running.
 * @param pid - Process id.
 * @returns true when the process exists.
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
