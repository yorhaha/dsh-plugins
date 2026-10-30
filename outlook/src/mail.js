/**
 * Mail capture: Graph `/me/messages` with a timestamp cursor.
 *
 * A personal Microsoft account refuses change tracking on messages
 * (`/me/messages/delta` answers 400), so this capture advances by
 * `receivedDateTime` instead: the first capture takes a bounded recent window,
 * later ones re-read a short reconcile window before the cursor, and `backfill`
 * walks further back a bounded number of pages at a time. Every write is keyed
 * by the upstream message id, so a re-read of the same boundary second updates
 * a row instead of duplicating it.
 *
 * `Prefer: IdType="ImmutableId"` keeps a message's id stable when it moves
 * between folders; without it, moving a message would file it as a new one.
 *
 * `/me/messages` answers with mail from every folder, Junk Email included, so
 * the folders a capture must not store are resolved to ids and skipped as the
 * pages arrive. The ids travel back with the capture, and the commit drops rows
 * already filed there, which is how a folder added to the exclusion list takes
 * effect on a corpus captured before it.
 *
 * @module dsh-outlook/src/mail
 */

import { truncateBytes } from './text.js'

/** Messages per page; Graph accepts up to 1000, this stays well clear of throttling. */
const PAGE_SIZE = 100

/** Properties every message request selects. */
const MESSAGE_SELECT = [
  'id', 'subject', 'bodyPreview', 'body', 'from', 'toRecipients', 'ccRecipients',
  'receivedDateTime', 'sentDateTime', 'hasAttachments', 'isRead', 'isDraft',
  'importance', 'conversationId', 'webLink', 'categories', 'parentFolderId',
].join(',')

/** Request preferences: stable ids across folder moves, plain-text bodies. */
const MESSAGE_HEADERS = { prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' }

/** Properties every folder request selects. */
const FOLDER_SELECT = 'id,displayName'

/** Milliseconds in one day. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * One participant as this corpus records it.
 * @param value - A Graph `recipient` or `from` wrapper.
 * @param role - Role the participant plays in the message.
 * @returns the actor, or null when the wrapper carries no address.
 */
function actorOf(value, role) {
  const address = value?.emailAddress
  if (address?.address === undefined || address.address === '') return null
  return { name: address.name ?? null, id: address.address, role }
}

/**
 * Display form of a message's sender.
 * @param message - A Graph message.
 * @returns the sender, or null when the message carries none.
 */
function senderOf(message) {
  const address = message?.from?.emailAddress
  if (address?.address === undefined || address.address === '') return null
  return address.name === undefined || address.name === ''
    ? address.address
    : `${address.name} <${address.address}>`
}

/**
 * Graph instant to ISO-8601 UTC.
 * @param value - A Graph date-time string.
 * @returns the instant, or null when the value is absent or unparseable.
 */
function instantOf(value) {
  if (typeof value !== 'string' || value === '') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/**
 * One Graph message as a corpus record. Pure, so the mapping is testable without
 * a network or a database.
 * @param message - A Graph message.
 * @param options - Mapping options.
 * @param options.bodyMaxBytes - Ceiling on the stored body text.
 * @returns the record to commit.
 */
export function messageToRecord(message, { bodyMaxBytes }) {
  const actors = []
  const sender = actorOf(message?.from, 'from')
  if (sender !== null) actors.push(sender)
  for (const [field, role] of [['toRecipients', 'to'], ['ccRecipients', 'cc']]) {
    for (const recipient of message?.[field] ?? []) {
      const actor = actorOf(recipient, role)
      if (actor !== null) actors.push(actor)
    }
  }
  const body = message?.body?.content ?? message?.bodyPreview ?? ''
  return {
    sourceId: message.id,
    kind: 'message',
    ts: instantOf(message.receivedDateTime ?? message.sentDateTime),
    tsEnd: null,
    title: message.subject ?? null,
    sender: senderOf(message),
    body: truncateBytes(typeof body === 'string' ? body.trim() : '', bodyMaxBytes),
    actors,
    metadata: {
      conversationId: message.conversationId ?? null,
      isRead: message.isRead === true,
      isDraft: message.isDraft === true,
      importance: message.importance ?? null,
      hasAttachments: message.hasAttachments === true,
      categories: Array.isArray(message.categories) ? message.categories : [],
      parentFolderId: message.parentFolderId ?? null,
      sentAt: instantOf(message.sentDateTime),
      webLink: message.webLink ?? null,
    },
    contentKey: message.conversationId ?? null,
  }
}

/**
 * Resolve the configured folder names to the folder ids this mailbox uses.
 *
 * `/me/messages` answers with mail from every folder, so a folder this capture
 * must not store has to be resolved to its id and skipped. A name is read as a
 * Graph well-known folder alias first (`junkemail`, `deleteditems`, …), which is
 * what a deployment normally states; a name the mailbox has no alias for is
 * matched against the top-level folders' display names, so a localized or a
 * custom folder can be named as the user sees it.
 *
 * @param options - Resolution inputs.
 * @param options.client - Authenticated Graph client.
 * @param options.names - Configured folder names.
 * @returns folder ids to skip, each mapped to the folder's display name.
 * @throws {GraphError} with code `invalid_settings` when a name matches no folder.
 */
export async function resolveExcludedFolders({ client, names }) {
  const excluded = new Map()
  let topLevel = null
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (name === '') continue
    let folder = null
    try {
      folder = await client.get(`/me/mailFolders/${encodeURIComponent(name)}`, {
        params: { $select: FOLDER_SELECT },
      })
    } catch (error) {
      // A name that is no well-known alias is matched by display name below; a
      // refused sign-in or a throttled mailbox is this capture's failure and is
      // reported as one.
      if (error?.code !== 'http_404') throw error
    }
    if (folder?.id === undefined) {
      topLevel ??= (await client.get('/me/mailFolders', {
        params: { $top: '100', $select: FOLDER_SELECT },
      }))?.value ?? []
      folder = topLevel.find(
        (entry) => String(entry?.displayName ?? '').toLowerCase() === name.toLowerCase(),
      ) ?? null
    }
    if (folder?.id === undefined) {
      // A name that matches nothing would otherwise capture the folder it was
      // meant to exclude, and look like success.
      throw Object.assign(
        new Error(`outlook: config.mailExcludeFolders names "${name}", which this mailbox has no folder for`),
        { code: 'invalid_settings' },
      )
    }
    excluded.set(folder.id, folder.displayName ?? name)
  }
  return excluded
}

/**
 * Capture one slice of the mailbox.
 *
 * @param options - Capture options.
 * @param options.client - Authenticated Graph client.
 * @param options.cursor - The stored cursor state, if any.
 * @param options.now - Current instant in milliseconds.
 * @param options.settings - Resolved capture settings.
 * @param options.backfill - Walk backwards from the oldest known message.
 * @param options.onProgress - Progress reporter.
 * @returns the records to commit and the cursor to store with them.
 */
export async function fetchMail({ client, cursor, now, settings, backfill, onProgress }) {
  const state = cursor?.state ?? {}
  const records = []
  const seen = new Set()
  let newest = state.last_received ?? null
  let oldest = state.oldest_received ?? null
  let snapshotComplete = state.initial_complete === true
  let pages = 0

  const excluded = (settings.excludeFolders ?? []).length === 0
    ? new Map()
    : await resolveExcludedFolders({ client, names: settings.excludeFolders })
  if (excluded.size > 0) {
    onProgress?.({ message: `mail: skipping ${[...excluded.values()].join(', ')}` })
  }

  const collect = (message) => {
    if (typeof message?.id !== 'string' || message.id === '') return
    if (excluded.has(message.parentFolderId)) return
    if (seen.has(message.id)) return
    seen.add(message.id)
    const record = messageToRecord(message, { bodyMaxBytes: settings.bodyMaxBytes })
    records.push(record)
    if (record.ts !== null) {
      if (newest === null || record.ts > newest) newest = record.ts
      if (oldest === null || record.ts < oldest) oldest = record.ts
    }
  }

  if (backfill === true && oldest !== null) {
    onProgress?.({ message: `mail: backfill before ${oldest}` })
    for await (const page of client.pages('/me/messages', {
      params: {
        $select: MESSAGE_SELECT,
        $orderby: 'receivedDateTime desc',
        $top: String(PAGE_SIZE),
        $filter: `receivedDateTime lt ${oldest}`,
      },
      headers: MESSAGE_HEADERS,
      maxPages: settings.backfillMaxPages,
    })) {
      pages += 1
      const items = page.value ?? []
      for (const message of items) collect(message)
      if (items.length < PAGE_SIZE) snapshotComplete = true
    }
  } else {
    const since = sinceFor({ state, now, settings })
    onProgress?.({ message: since === null ? 'mail: full capture' : `mail: since ${since}` })
    for await (const page of client.pages('/me/messages', {
      params: {
        $select: MESSAGE_SELECT,
        $orderby: 'receivedDateTime asc',
        $top: String(PAGE_SIZE),
        ...(since === null ? {} : { $filter: `receivedDateTime ge ${since}` }),
      },
      headers: MESSAGE_HEADERS,
      maxPages: settings.mailMaxPages,
    })) {
      pages += 1
      const items = page.value ?? []
      for (const message of items) collect(message)
      if (since === null && items.length < PAGE_SIZE) snapshotComplete = true
    }
  }

  return {
    records,
    removed: [],
    excludedFolderIds: [...excluded.keys()],
    cursor: {
      state: {
        last_received: newest,
        oldest_received: oldest,
        initial_complete: snapshotComplete,
        pulled: records.length,
      },
      itemCount: records.length,
      snapshotComplete,
    },
    pages,
  }
}

/**
 * Lower bound for the next forward capture.
 *
 * The stored cursor is pulled back by the reconcile window so that read state,
 * importance, and folder moves that happened after a message arrived are
 * observed; nothing else can see them, because this mailbox has no change feed.
 *
 * @param options - Cursor inputs.
 * @param options.state - Stored cursor state.
 * @param options.now - Current instant in milliseconds.
 * @param options.settings - Resolved capture settings.
 * @returns the bound as a Graph filter value, or null for a full capture.
 */
function sinceFor({ state, now, settings }) {
  if (typeof state.last_received === 'string' && state.last_received !== '') {
    const reconciled = new Date(Date.parse(state.last_received) - settings.reconcileDays * DAY_MS)
    return graphInstant(reconciled)
  }
  if (settings.initialDays <= 0) return null
  return graphInstant(new Date(now - settings.initialDays * DAY_MS))
}

/**
 * Format an instant the way Graph's `$filter` expects it.
 * @param date - The instant.
 * @returns the second-precision UTC string.
 */
function graphInstant(date) {
  return `${date.toISOString().slice(0, 19)}Z`
}
