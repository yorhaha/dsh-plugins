/**
 * Containment tests for the memory browser's path gate.
 *
 * These cases are the plugin's real security surface: the file routes hand an
 * HTTP request a filesystem write, so a path that escapes its root is a
 * vulnerability, not a bug. The symlink cases need a real filesystem and are
 * therefore built in a temporary directory rather than mocked.
 *
 * @module dsh-file-memory/tests/safe-path
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  PATH_REFUSALS,
  PathRefusal,
  isContained,
  normalizeRelative,
  resolveWithinRoot,
  toRelative,
} from '../src/safe-path.js'

/** Code of the refusal thrown by `operation`, or `undefined` when it resolved. */
async function refusalCode(operation) {
  try {
    await operation()
    return undefined
  } catch (error) {
    if (error instanceof PathRefusal) return error.code
    throw error
  }
}

describe('normalizeRelative', () => {
  it('treats an absent or empty path as the root itself', () => {
    assert.equal(normalizeRelative(undefined), '')
    assert.equal(normalizeRelative(''), '')
    assert.equal(normalizeRelative('/'), '')
    assert.equal(normalizeRelative('///'), '')
  })

  it('strips leading and trailing separators instead of refusing them', () => {
    assert.equal(normalizeRelative('/a/b.md'), 'a/b.md')
    assert.equal(normalizeRelative('a/b.md/'), 'a/b.md')
    assert.equal(normalizeRelative('/a/b.md/'), 'a/b.md')
  })

  it('keeps interior structure intact', () => {
    assert.equal(normalizeRelative('a/b/c.md'), 'a/b/c.md')
  })

  it('refuses a NUL byte', () => {
    assert.throws(() => normalizeRelative('a\0b.md'), { code: PATH_REFUSALS.malformed })
  })

  it('refuses a non-string', () => {
    assert.throws(() => normalizeRelative(7), { code: PATH_REFUSALS.malformed })
  })
})

describe('isContained', () => {
  it('accepts the root itself', () => {
    assert.equal(isContained('/a/b', '/a/b'), true)
  })

  it('accepts a descendant', () => {
    assert.equal(isContained('/a/b', `/a/b/c${sep}d`), true)
  })

  it('rejects a sibling sharing a name prefix', () => {
    // The case a bare `startsWith` gets wrong: `/a/bc` is not inside `/a/b`.
    assert.equal(isContained('/a/b', '/a/bc'), false)
  })

  it('rejects an ancestor', () => {
    assert.equal(isContained('/a/b', '/a'), false)
  })
})

describe('resolveWithinRoot', () => {
  /** Canonical temporary root holding the fixture tree. */
  let root
  /** Directory outside the root, used as a symlink destination. */
  let outside

  before(async () => {
    // Canonicalize the fixture root: on macOS the temporary directory is
    // itself reached through a symlink, and `resolveWithinRoot` returns
    // canonical paths, so assertions must be built from the same base.
    const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-file-memory-')))
    root = join(base, 'memory')
    outside = join(base, 'outside')
    await mkdir(join(root, 'decisions'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(root, 'decisions', 'a.md'), '# a\n')
    await writeFile(join(outside, 'secret.md'), '# secret\n')
    // A link inside the root pointing outside it. Lexically it looks contained;
    // only canonicalization reveals that it is not.
    await symlink(outside, join(root, 'escape-dir'))
    await symlink(join(outside, 'secret.md'), join(root, 'escape-file.md'))
    // A link that stays inside the root must keep working.
    await symlink(join(root, 'decisions'), join(root, 'inside-link'))
  })

  after(async () => {
    await rm(dirname(root), { recursive: true, force: true })
  })

  it('resolves the root for an empty path', async () => {
    assert.equal(await resolveWithinRoot(root, ''), root)
  })

  it('resolves a plain descendant', async () => {
    assert.equal(await resolveWithinRoot(root, 'decisions/a.md'), join(root, 'decisions', 'a.md'))
  })

  it('refuses a lexical escape', async () => {
    assert.equal(
      await refusalCode(() => resolveWithinRoot(root, '../outside/secret.md')),
      PATH_REFUSALS.outside,
    )
  })

  it('refuses an encoded traversal that normalizes into an escape', async () => {
    assert.equal(
      await refusalCode(() => resolveWithinRoot(root, 'decisions/../../outside/secret.md')),
      PATH_REFUSALS.outside,
    )
  })

  it('refuses a symlinked directory that leaves the root', async () => {
    assert.equal(
      await refusalCode(() => resolveWithinRoot(root, 'escape-dir/secret.md')),
      PATH_REFUSALS.outside,
    )
  })

  it('refuses a symlinked file that leaves the root', async () => {
    assert.equal(
      await refusalCode(() => resolveWithinRoot(root, 'escape-file.md')),
      PATH_REFUSALS.outside,
    )
  })

  it('allows a symlink that stays inside the root', async () => {
    assert.equal(
      await resolveWithinRoot(root, 'inside-link/a.md'),
      join(root, 'decisions', 'a.md'),
    )
  })

  it('refuses to create under a directory symlink that leaves the root', async () => {
    // The creation path canonicalizes the parent, so this must be refused even
    // though the target itself does not exist yet.
    assert.equal(
      await refusalCode(() => resolveWithinRoot(root, 'escape-dir/new.md')),
      PATH_REFUSALS.outside,
    )
  })

  it('resolves a not-yet-existing file under an existing directory', async () => {
    assert.equal(
      await resolveWithinRoot(root, 'decisions/new.md'),
      join(root, 'decisions', 'new.md'),
    )
  })

  it('resolves a not-yet-existing nested path whose deepest parent exists', async () => {
    assert.equal(
      await resolveWithinRoot(root, 'decisions/deep/new.md'),
      join(root, 'decisions', 'deep', 'new.md'),
    )
  })

  it('refuses an absent target when existence is required', async () => {
    assert.equal(
      await refusalCode(() => resolveWithinRoot(root, 'decisions/missing.md', { mustExist: true })),
      PATH_REFUSALS.notFound,
    )
  })

  it('enforces the required extension', async () => {
    assert.equal(
      await refusalCode(() => resolveWithinRoot(root, 'decisions/a.txt', { extension: '.md' })),
      PATH_REFUSALS.wrongExtension,
    )
  })

  it('applies the extension rule to the final segment only', async () => {
    assert.equal(
      await resolveWithinRoot(root, 'decisions.md/a.md', { extension: '.md' }),
      join(root, 'decisions.md', 'a.md'),
    )
  })

  it('does not apply the extension rule to the root', async () => {
    assert.equal(await resolveWithinRoot(root, '', { extension: '.md' }), root)
  })
})

describe('toRelative', () => {
  it('returns an empty string for the root', () => {
    assert.equal(toRelative('/a/b', '/a/b'), '')
  })

  it('returns a slash-separated tail', () => {
    assert.equal(toRelative('/a/b', `/a/b/c${sep}d.md`), 'c/d.md')
  })
})
