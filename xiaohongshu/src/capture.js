/**
 * One bounded capture run: search or named notes in, normalized corpus rows out.
 *
 * A search answers with cards, which are cheap: one request yields up to twenty
 * titles, authors and engagement counts. Full bodies are fetched only for the
 * first `detailLimit` notes that do not already have one, so a capture of a
 * keyword costs one search plus a handful of detail reads rather than a crawl.
 *
 * @module dsh-xiaohongshu/src/capture
 */

import { randomBytes } from 'node:crypto'
import { downloadImages } from './media.js'
import { nowIso } from './store.js'

/**
 * A short identifier for one capture run.
 * @returns the id.
 */
export function newRunId() {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/**
 * Parse a note id and its token from an id, URL, or share text.
 * @param input - one note reference.
 * @returns the note id and optional token/source.
 */
export function parseNoteReference(input) {
  const value = String(input ?? '').trim()
  if (value === '') return null
  let url
  try {
    url = new URL(value)
  } catch {
    url = null
  }
  if (url !== null) {
    const match = /\/explore\/([A-Za-z0-9]+)/.exec(url.pathname)
    if (match === null) return null
    return {
      noteId: match[1],
      xsecToken: url.searchParams.get('xsec_token') ?? undefined,
      xsecSource: url.searchParams.get('xsec_source') ?? undefined,
    }
  }
  const id = /^[A-Za-z0-9]{8,40}$/.exec(value)
  if (id === null) return null
  return { noteId: value, xsecToken: undefined, xsecSource: undefined }
}

/**
 * Capture one note's detail, media, and optional comments.
 *
 * @param options - client, store, config, note reference, and flags.
 * @returns counts for this note.
 */
async function captureNote({ client, store, config, noteId, xsecToken, xsecSource, comments, logger, onProgress }) {
  onProgress?.(`reading note ${noteId}`)
  const { note } = await client.note({ noteId, xsecToken, xsecSource })
  let media = []
  if (config.downloadMedia && note.images.length > 0) {
    onProgress?.(`downloading ${note.images.length} images for ${noteId}`)
    media = await downloadImages(note.note_id, note.images, {
      mediaRoot: store.mediaRoot,
      maxBytes: config.mediaMaxBytes,
      concurrency: config.mediaConcurrency,
      timeoutMs: config.mediaTimeoutMs,
      logger,
    })
    note.images = media
  }
  store.upsertNote(note, { capturedAt: nowIso() })
  if (media.length > 0) {
    for (const [index, image] of media.entries()) store.saveMedia(note.note_id, index, image)
  }
  let commentCount = 0
  if (comments) {
    onProgress?.(`reading comments for ${noteId}`)
    const page = await client.comments({ noteId: note.note_id, xsecToken: note.xsec_token ?? xsecToken, xsecSource: note.xsec_source ?? xsecSource })
    commentCount = store.insertComments(note.note_id, page.comments)
  }
  return { note: note.note_id, comments: commentCount, media: media.filter((image) => image.local_path !== null).length }
}

/**
 * Run one capture.
 *
 * @param options - client, store, config, logger, and the caller's arguments.
 * @returns the capture summary.
 */
export async function capture({ client, store, config, logger, onProgress, args }) {
  const runId = newRunId()
  const capturedAt = nowIso()
  const summary = {
    run_id: runId,
    query: typeof args.query === 'string' ? args.query : null,
    cards: 0,
    details: 0,
    comments: 0,
    media: 0,
    failures: [],
  }

  const references = []
  if (Array.isArray(args.note_ids)) {
    for (const input of args.note_ids.slice(0, config.captureMaxNotes)) {
      const parsed = parseNoteReference(input)
      if (parsed === null) {
        summary.failures.push({ input: String(input), code: 'invalid_note_reference' })
        continue
      }
      references.push(parsed)
    }
  }

  if (typeof args.query === 'string' && args.query.trim() !== '') {
    onProgress?.(`searching "${args.query}"`)
    const result = await client.search({
      query: args.query,
      limit: Math.min(args.limit ?? config.captureDefaultNotes, config.captureMaxNotes),
    })
    summary.cards = result.notes.length
    store.upsertNotes(result.notes, { capturedAt })
    for (const note of result.notes) store.recordCapture(runId, note.note_id, 'search', args.query)
    const detailLimit = Math.min(args.detail_limit ?? config.detailDefaultLimit, config.detailMaxLimit)
    for (const note of result.notes) {
      if (references.length >= detailLimit) break
      const existing = store.getNote(note.note_id)
      if (existing?.body) continue
      references.push({ noteId: note.note_id, xsecToken: note.xsec_token, xsecSource: note.xsec_source })
      if (references.length >= detailLimit) break
    }
  }

  const seen = new Set()
  for (const reference of references) {
    if (seen.has(reference.noteId)) continue
    seen.add(reference.noteId)
    try {
      const result = await captureNote({
        client,
        store,
        config,
        noteId: reference.noteId,
        xsecToken: reference.xsecToken,
        xsecSource: reference.xsecSource,
        comments: args.comments === true,
        logger,
        onProgress,
      })
      summary.details += 1
      summary.comments += result.comments
      summary.media += result.media
      store.recordCapture(runId, reference.noteId, 'note', null)
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'capture_failed'
      logger?.warn?.(`xiaohongshu: capture of ${reference.noteId} failed: ${code}`)
      summary.failures.push({ note_id: reference.noteId, code })
      if (code === 'temporarily_blocked' || code === 'request_budget_exhausted' || code === 'risk_control') break
    }
  }

  const stats = store.stats()
  store.updateStatus({ last_capture_at: summary.details > 0 || summary.cards > 0 ? capturedAt : store.getStatus().last_capture_at, note_count: stats.note_count })
  return summary
}
