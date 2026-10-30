/**
 * Path containment for the memory browser's file routes.
 *
 * The file routes give an HTTP channel that writes to disk, so every path that
 * arrives from a browser is untrusted and must be proved to stay inside one
 * declared root before it reaches the filesystem. Two rules carry that proof:
 *
 * 1. Roots are canonicalized once, at load, with `realpath`. Comparing against
 *    a root that still contains a symbolic link would let a link inside the
 *    root redirect an apparently-contained path outside it.
 * 2. Every target is canonicalized the same way before the comparison. A
 *    lexical check (`path.resolve` plus a prefix test) is NOT sufficient: a
 *    symlink inside the root resolves outside it while remaining lexically
 *    contained.
 *
 * A path that does not exist yet — a file about to be created — cannot be
 * canonicalized itself, so its parent directory is canonicalized instead and
 * the final segment is appended. That keeps creation inside the root without
 * requiring the target to pre-exist.
 *
 * @module dsh-file-memory/safe-path
 */

import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Refusal reasons a caller maps to an HTTP status without quoting a host path. */
export const PATH_REFUSALS = Object.freeze({
  /** The path was empty, absolute, or contained a NUL byte. */
  malformed: 'malformed_path',
  /** The resolved target leaves the declared root, or a symlink redirected it out. */
  outside: 'outside_root',
  /** The target is a directory where a file was required (or the reverse). */
  wrongKind: 'wrong_kind',
  /** The extension is not one this route serves. */
  wrongExtension: 'wrong_extension',
  /** The target was required to exist and does not. */
  notFound: 'not_found',
})

/**
 * A refusal carrying a stable code. The message never quotes a host path, so a
 * refused request cannot be used to probe the filesystem layout.
 */
export class PathRefusal extends Error {
  /**
   * @param code - one of {@link PATH_REFUSALS}.
   * @param detail - short non-path explanation for the server log.
   */
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'PathRefusal'
    this.code = code
  }
}

/**
 * True when `child` is `parent` itself or lies beneath it.
 *
 * A plain `startsWith` is wrong here: `/a/bc` starts with `/a/b` but is not
 * inside it. The separator must be part of the comparison.
 * @param parent - canonical absolute parent directory.
 * @param child - canonical absolute candidate.
 * @returns whether the candidate is contained.
 */
export function isContained(parent, child) {
  if (child === parent) return true
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Reject a browser-supplied relative path before any filesystem call.
 * @param value - the raw `path` query parameter, if any.
 * @returns the path with redundant separators removed, or `''` for the root.
 * @throws {PathRefusal} when the value cannot be a relative path under a root.
 */
export function normalizeRelative(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new PathRefusal(PATH_REFUSALS.malformed, 'not a string')
  if (value.includes('\0')) throw new PathRefusal(PATH_REFUSALS.malformed, 'NUL byte')
  // A leading separator is stripped rather than refused: the client sends
  // workspace-relative paths and treating `/a.md` as `a.md` is unambiguous.
  const trimmed = value.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '')
  if (trimmed === '') return ''
  if (isAbsolute(trimmed)) throw new PathRefusal(PATH_REFUSALS.malformed, 'absolute path')
  return trimmed
}

/**
 * Resolve one browser-supplied path to a canonical absolute path inside a root.
 *
 * The root is canonicalized here rather than trusted from the caller. A root
 * that still contains a symbolic link — `/var/...` on macOS, for instance —
 * would make the containment test compare a canonical target against a
 * non-canonical parent and refuse legitimate paths.
 *
 * @param root - absolute root directory; need not be canonical.
 * @param value - the raw relative path from the request.
 * @param options - `mustExist` refuses a target that is absent; `extension`
 *   requires that suffix on the final segment.
 * @returns the canonical absolute target.
 * @throws {PathRefusal} when the path is malformed, escapes the root, or
 *   violates the requested existence or extension rule.
 */
export async function resolveWithinRoot(root, value, options = {}) {
  const canonicalRoot = await canonicalizeRoot(root)
  const relative = normalizeRelative(value)
  const lexical = relative === '' ? canonicalRoot : resolve(canonicalRoot, relative)

  // Cheap lexical refusal first, so an obvious `../..` never reaches the
  // filesystem. This is a fast path only; the canonical check below is the
  // one that decides.
  if (!isContained(canonicalRoot, lexical)) throw new PathRefusal(PATH_REFUSALS.outside, 'lexical escape')

  const canonical = await canonicalize(canonicalRoot, lexical, options.mustExist === true)

  if (!isContained(canonicalRoot, canonical)) throw new PathRefusal(PATH_REFUSALS.outside, 'symlink escape')

  if (options.extension !== undefined && canonical !== canonicalRoot) {
    if (!canonical.toLowerCase().endsWith(options.extension)) {
      throw new PathRefusal(PATH_REFUSALS.wrongExtension, `expected ${options.extension}`)
    }
  }

  return canonical
}

/**
 * Canonicalize a root, requiring that it exists and is a directory.
 * @param root - absolute candidate root.
 * @returns its canonical absolute path.
 * @throws {PathRefusal} when the root is not an absolute existing directory.
 */
export async function canonicalizeRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new PathRefusal(PATH_REFUSALS.malformed, 'root must be absolute')
  }
  try {
    return await realpath(root)
  } catch (error) {
    if (isMissing(error)) throw new PathRefusal(PATH_REFUSALS.malformed, 'root does not exist')
    throw error
  }
}

/**
 * Canonicalize a target, tolerating absent trailing segments.
 *
 * When the target is missing and absence is allowed, the walk climbs to the
 * nearest existing ancestor, canonicalizes that, and re-appends every missing
 * segment. Climbing (rather than canonicalizing one parent) is what makes
 * creation work at arbitrary depth: `a/b/c.md` whose `a/b` is also absent is
 * legitimate when `a` exists.
 *
 * The canonical ancestor must be inside the root, which is what keeps creation
 * from following a symlink out.
 *
 * @param root - canonical root, bounding the climb.
 * @param lexical - the resolved but not yet canonical target.
 * @param mustExist - refuse instead of tolerating absent trailing segments.
 * @returns the canonical absolute target.
 * @throws {PathRefusal} when the target is absent and required, or the nearest
 *   existing ancestor escapes the root.
 */
async function canonicalize(root, lexical, mustExist) {
  try {
    return await realpath(lexical)
  } catch (error) {
    if (!isMissing(error) || mustExist) {
      if (isMissing(error)) throw new PathRefusal(PATH_REFUSALS.notFound, 'does not exist')
      throw error
    }
  }

  const missing = []
  let ancestor = lexical
  for (;;) {
    const parent = dirname(ancestor)
    // `dirname` is its own result only at the filesystem root, so this also
    // terminates the climb for a target that is entirely absent.
    if (parent === ancestor) throw new PathRefusal(PATH_REFUSALS.malformed, 'no existing ancestor')
    missing.unshift(ancestor.slice(parent.length + sep.length))
    ancestor = parent
    try {
      const canonicalAncestor = await realpath(ancestor)
      if (!isContained(root, canonicalAncestor)) {
        throw new PathRefusal(PATH_REFUSALS.outside, 'parent escapes root')
      }
      return join(canonicalAncestor, ...missing)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
}

/**
 * True for an `ENOENT`-family failure.
 * @param error - the thrown value.
 * @returns whether the target was absent.
 */
function isMissing(error) {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/**
 * Join a canonical root and target into the browser-facing relative path.
 * @param root - canonical absolute root.
 * @param target - canonical absolute target.
 * @returns the path relative to the root, using `/` separators.
 */
export function toRelative(root, target) {
  if (target === root) return ''
  const tail = target.slice(root.endsWith(sep) ? root.length : root.length + 1)
  return tail.split(sep).join('/')
}
