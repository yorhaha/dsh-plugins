/**
 * The memory browser's Host routes.
 *
 * The browser half cannot reach this plugin through a Remote namespace: client
 * namespaces come from a fixed list compiled into the web application, and a
 * profile-installed bundle cannot declare one. It therefore goes through exact
 * Fetch routes registered on the shared API channel, which means the harness's
 * Host/Origin fence and browser authentication have already run before any
 * handler here is reached — this module adds no authentication of its own and
 * must not be mounted outside that channel.
 *
 * Routes are exact paths, so the operation and target travel as query
 * parameters rather than path segments. There is one configured root, so no
 * request selects between roots.
 *
 * Every request path is untrusted and is proved contained by `safe-path.js`
 * before it reaches the filesystem. A refusal is reported without quoting a
 * host path, so the channel cannot be used to probe the filesystem layout.
 *
 * @module dsh-file-memory/routes
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { PathRefusal, resolveWithinRoot, toRelative } from './safe-path.js'
import { sendJson } from '../../shared/route.js'

/** The one GET route; `op` selects tree or file. */
export const READ_PATH = '/api/plugin-file-memory/read'

/** The one POST route; `op` selects write, delete, or mkdir. */
export const MUTATE_PATH = '/api/plugin-file-memory/mutate'

/** Directory names never traversed or shown. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.cache', 'dist', 'build'])

/** Only markdown is served or written; this channel must not write arbitrary files. */
const ALLOWED_EXTENSION = '.md'

/** Largest JSON body accepted on the mutate route. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** Map a thrown value to a response, keeping host paths out of the client's view. */
function sendFailure(error) {
  // A refusal is always the client's fault: it asked for a path this channel
  // does not serve. The code names which rule refused it.
  if (error instanceof PathRefusal) {
    return sendJson(error.code === 'not_found' ? 404 : 400, { ok: false, error: error.code })
  }
  if (error instanceof PayloadError) return sendJson(error.status, { ok: false, error: error.code })
  const code = typeof error?.code === 'string' ? error.code : 'internal'
  if (code === 'ENOENT') return sendJson(404, { ok: false, error: 'not_found' })
  if (code === 'EISDIR' || code === 'ENOTDIR') return sendJson(400, { ok: false, error: 'wrong_kind' })
  if (code === 'EACCES' || code === 'EPERM') return sendJson(403, { ok: false, error: 'denied' })
  return sendJson(500, { ok: false, error: 'internal' })
}

/** A request defect carrying the status it deserves. */
class PayloadError extends Error {
  constructor(status, code) {
    super(code)
    this.name = 'PayloadError'
    this.status = status
    this.code = code
  }
}

/**
 * Decode a byte buffer as UTF-8, refusing a prefix longer than the byte limit.
 * @param bytes - the file's bytes.
 * @param limit - largest accepted prefix.
 * @returns the decoded text, or `undefined` when the limit was exceeded.
 */
function decodeWithin(bytes, limit) {
  if (bytes.length > limit) return undefined
  // A memory file is text the panel will save back; decoding invalid bytes with
  // replacement characters would rewrite them and silently corrupt the file.
  const decoder = new TextDecoder('utf-8', { fatal: true })
  return decoder.decode(bytes)
}

/**
 * Read one UTF-8 file, refusing anything larger than the configured bound.
 * @param target - canonical absolute file path.
 * @param limit - largest accepted size in bytes.
 * @returns its text.
 * @throws {PayloadError} when the file exceeds the bound.
 */
async function readTextWithin(target, limit) {
  const info = await stat(target)
  // A FIFO or device file with a `.md` name would make `readFile` wait forever,
  // so this route serves regular files only.
  if (!info.isFile()) throw new PayloadError(400, 'wrong_kind')
  if (info.size > limit) throw new PayloadError(413, 'too_large')
  const bytes = await readFile(target)
  let text
  try {
    text = decodeWithin(bytes, limit)
  } catch {
    throw new PayloadError(400, 'invalid_encoding')
  }
  if (text === undefined) throw new PayloadError(413, 'too_large')
  return text
}

/**
 * Write text to one path atomically.
 *
 * The temporary file is created beside the destination so the rename is a
 * same-filesystem operation, and it is removed if anything fails after
 * creation. An existing symlink is followed first, so the write lands on the
 * file the link names rather than replacing the link.
 *
 * @param requested - the canonical path the client asked for.
 * @param text - the content to write.
 * @returns the canonical path actually written.
 */
async function writeTextAtomic(requested, text) {
  let destination = requested
  try {
    destination = await realpath(requested)
  } catch {
    // The destination does not exist yet; it is created in place.
  }
  // The containment check already proved the destination sits inside the root,
  // so creating the directories that lead to it cannot escape. Without this,
  // writing `a/b/new.md` into a fresh tree fails on the absent parent.
  await mkdir(dirname(destination), { recursive: true })
  const temporary = join(dirname(destination), `.file-memory-${randomBytes(8).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return destination
}

/**
 * Walk one root into a nested tree.
 * @param root - canonical absolute root.
 * @param maxDepth - deepest level to include.
 * @returns `{ children, unreadable }`, with directories ordered before files.
 */
async function buildTree(root, maxDepth) {
  let unreadable = 0
  async function walk(directory, depth) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      unreadable += 1
      return []
    }
    const nodes = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absolute = join(directory, entry.name)
      const relative = toRelative(root, absolute)
      // `isDirectory()` is false for a symbolic link, so a linked directory is
      // never traversed or shown. That is deliberate: following one could list
      // and later edit content outside the memory root.
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue
        // At the bound the directory is listed without its contents: the walk
        // stops rather than hiding the directory, and an empty `children`
        // reads the same as an empty directory. `maxDepth` is configurable.
        if (depth >= maxDepth) {
          nodes.push({ type: 'dir', name: entry.name, path: relative, children: [] })
          continue
        }
        nodes.push({
          type: 'dir',
          name: entry.name,
          path: relative,
          children: await walk(absolute, depth + 1),
        })
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.toLowerCase().endsWith(ALLOWED_EXTENSION)) continue
      try {
        const info = await stat(absolute)
        nodes.push({
          type: 'file',
          name: entry.name,
          path: relative,
          size: info.size,
          mtime: info.mtimeMs,
        })
      } catch {
        unreadable += 1
      }
    }
    nodes.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    return nodes
  }
  return { children: await walk(root, 1), unreadable }
}

/**
 * Handle one GET request.
 * @param request - the Fetch request.
 * @param config - resolved plugin configuration.
 * @returns the response.
 */
async function handleRead(request, config) {
  const url = new URL(request.url)
  const operation = url.searchParams.get('op') ?? 'tree'
  // Canonicalize once: `toRelative` must measure against the same root that
  // `resolveWithinRoot` produced, or a root reached through a symbolic link
  // yields a path relative to the wrong prefix (and the client would save to it).
  const canonicalRoot = await resolveWithinRoot(config.root, '')

  if (operation === 'tree') {
    const { children, unreadable } = await buildTree(canonicalRoot, config.maxDepth)
    return sendJson(200, { ok: true, root: canonicalRoot, children, unreadable })
  }

  if (operation === 'file') {
    const target = await resolveWithinRoot(config.root, url.searchParams.get('path'), {
      mustExist: true,
      extension: ALLOWED_EXTENSION,
    })
    const text = await readTextWithin(target, config.maxFileBytes)
    const info = await stat(target)
    return sendJson(200, {
      ok: true,
      path: toRelative(canonicalRoot, target),
      text,
      bytes: info.size,
      mtime: info.mtimeMs,
    })
  }

  throw new PayloadError(400, 'unknown_op')
}

/**
 * Read and parse a bounded JSON body.
 *
 * The bound is tallied on the decoded text rather than on a declared
 * `content-length`, which a request may omit. `maxFileBytes` is far below this
 * one, so a legitimate write is never refused here.
 *
 * @param request - the Fetch request.
 * @returns the parsed value.
 * @throws {PayloadError} when the body is absent, oversized, or not JSON.
 */
async function readMutateBody(request) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new PayloadError(413, 'too_large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new PayloadError(413, 'too_large')
  try {
    return JSON.parse(text)
  } catch {
    throw new PayloadError(400, 'invalid_body')
  }
}

/**
 * Prove that a folder holds only entries the tree lists.
 *
 * A folder delete removes everything inside it, so the entries are checked
 * first: a hidden entry, a skipped directory such as `node_modules`, a
 * symbolic link, or a non-markdown file means the panel never showed that
 * content, and one request must not be able to erase it. The walk is not
 * bounded by `maxDepth`; deleting a folder means deleting the notes below it
 * however deep they sit.
 *
 * @param directory - canonical absolute folder about to be removed.
 * @throws {PayloadError} when any entry is not something the tree lists.
 */
async function assertDeletableFolder(directory) {
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) {
        throw new PayloadError(400, 'unlisted_content')
      }
      if (entry.isDirectory()) {
        pending.push(join(current, entry.name))
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(ALLOWED_EXTENSION)) continue
      throw new PayloadError(400, 'unlisted_content')
    }
  }
}

/**
 * Handle one POST request.
 * @param request - the Fetch request.
 * @param config - resolved plugin configuration.
 * @returns the response.
 */
async function handleMutate(request, config) {
  const url = new URL(request.url)
  const rootPath = config.root
  const operation = url.searchParams.get('op') ?? 'write'

  const canonicalRoot = await resolveWithinRoot(rootPath, '')

  if (operation === 'write') {
    const body = await readMutateBody(request)
    if (typeof body?.text !== 'string') throw new PayloadError(400, 'invalid_body')
    if (Buffer.byteLength(body.text, 'utf8') > config.maxFileBytes) {
      throw new PayloadError(413, 'too_large')
    }
    const requested = await resolveWithinRoot(rootPath, url.searchParams.get('path'), {
      extension: ALLOWED_EXTENSION,
    })
    if (requested === canonicalRoot) throw new PayloadError(400, 'wrong_kind')
    const destination = await writeTextAtomic(requested, body.text)
    const info = await stat(destination)
    return sendJson(200, {
      ok: true,
      path: toRelative(canonicalRoot, destination),
      bytes: info.size,
      mtime: info.mtimeMs,
    })
  }

  if (operation === 'mkdir') {
    const target = await resolveWithinRoot(rootPath, url.searchParams.get('path'))
    if (target === canonicalRoot) throw new PayloadError(400, 'wrong_kind')
    await mkdir(target, { recursive: true })
    return sendJson(200, { ok: true, path: toRelative(canonicalRoot, target) })
  }

  if (operation === 'delete') {
    // The extension rule is applied after the kind is known: a folder has no
    // `.md` suffix, and a file must still be one the panel serves.
    const target = await resolveWithinRoot(rootPath, url.searchParams.get('path'), {
      mustExist: true,
    })
    if (target === canonicalRoot) throw new PayloadError(400, 'wrong_kind')
    const relative = toRelative(canonicalRoot, target)
    // A hidden or skipped segment names a path the tree never showed, so a
    // request carrying one did not come from a listed row.
    if (relative.split('/').some(segment => segment.startsWith('.') || SKIPPED_DIRS.has(segment))) {
      throw new PayloadError(400, 'wrong_kind')
    }
    const info = await stat(target)
    if (info.isDirectory()) {
      await assertDeletableFolder(target)
      await rm(target, { recursive: true, force: false })
      return sendJson(200, { ok: true })
    }
    if (!info.isFile()) throw new PayloadError(400, 'wrong_kind')
    if (!target.toLowerCase().endsWith(ALLOWED_EXTENSION)) {
      throw new PayloadError(400, 'wrong_extension')
    }
    await rm(target, { force: false })
    return sendJson(200, { ok: true })
  }

  throw new PayloadError(400, 'unknown_op')
}

/**
 * Build the two route definitions for `ctx.connection.fetch.register`.
 * @param config - resolved plugin configuration.
 * @returns the routes, each closing over the configuration.
 */
export function buildRoutes(config) {
  return [
    {
      path: READ_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async request => {
        try {
          return await handleRead(request, config)
        } catch (error) {
          return sendFailure(error)
        }
      },
    },
    {
      path: MUTATE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => {
        try {
          return await handleMutate(request, config)
        } catch (error) {
          return sendFailure(error)
        }
      },
    },
  ]
}
