/**
 * Route behavior tests for the memory browser's Host half.
 *
 * These drive the registered `fetch` functions directly with Fetch `Request`
 * objects, which is the same entry point the connection channel calls after the
 * harness has applied its trust and authentication policy. Real files are read
 * and written under a temporary root; nothing here is mocked.
 *
 * The point of this suite is that the containment rules hold through the whole
 * request path, not only inside `safe-path.js`: a traversal attempt must come
 * back as a refusal, not as a 404 that would mean the route tried the access.
 *
 * @module dsh-file-memory/tests/routes
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { MUTATE_PATH, READ_PATH, buildRoutes } from '../src/routes.js'

/** Send one request through the route that owns it. */
async function call(routes, path, query = {}, body) {
  const route = routes.find(candidate => candidate.path === path)
  assert.ok(route !== undefined, `no route registered for ${path}`)
  const url = new URL(`http://localhost${path}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const request = new Request(url, body === undefined
    ? { method: route.methods[0] }
    : { method: route.methods[0], body: JSON.stringify(body) })
  const response = await route.fetch(request)
  const payload = await response.json()
  return { status: response.status, payload }
}

describe('file-memory routes', () => {
  /** Temporary base holding the memory root and an outside directory. */
  let base
  /** Configured memory root (canonical). */
  let memoryRoot
  /** Routes under test. */
  let routes

  before(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-file-memory-routes-')))
    memoryRoot = join(base, 'memory')
    const outside = join(base, 'outside')
    await mkdir(join(memoryRoot, 'decisions'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(memoryRoot, 'decisions', 'a.md'), '# a\n')
    await writeFile(join(memoryRoot, 'note.txt'), 'not markdown\n')
    await writeFile(join(outside, 'secret.md'), '# secret\n')
    await symlink(outside, join(memoryRoot, 'escape'))
    routes = buildRoutes({
      enabled: true,
      root: memoryRoot,
      maxDepth: 5,
      maxFileBytes: 4096,
    })
  })

  after(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('ignores a stale root selector rather than failing on it', async () => {
    // The two-root design is gone. A cached page may still send `root`; it must
    // be inert, not an error and not a way to reach another directory.
    const { status, payload } = await call(routes, READ_PATH, { root: 'user', op: 'tree' })
    assert.equal(status, 200)
    assert.equal(payload.root, memoryRoot)
  })

  it('refuses an unknown operation', async () => {
    const { status, payload } = await call(routes, READ_PATH, { op: 'nope' })
    assert.equal(status, 400)
    assert.equal(payload.error, 'unknown_op')
  })

  it('lists the tree with directories before files', async () => {
    const { status, payload } = await call(routes, READ_PATH, { op: 'tree' })
    assert.equal(status, 200)
    // `escape` is a symlinked directory and is deliberately absent: the walk
    // refuses to traverse links, so it can neither list nor later edit outside
    // the root.
    assert.deepEqual(payload.children.map(node => node.name), ['decisions'])
    const decisions = payload.children.find(node => node.name === 'decisions')
    assert.deepEqual(decisions.children.map(node => node.name), ['a.md'])
  })

  it('omits non-markdown files from the tree', async () => {
    const { payload } = await call(routes, READ_PATH, { op: 'tree' })
    const flat = JSON.stringify(payload.children)
    assert.equal(flat.includes('note.txt'), false)
  })

  it('reads a file', async () => {
    const { status, payload } = await call(routes, READ_PATH, { op: 'file', path: 'decisions/a.md',
    })
    assert.equal(status, 200)
    assert.equal(payload.text, '# a\n')
    assert.equal(payload.path, 'decisions/a.md')
  })

  it('refuses a traversal on read', async () => {
    const { status, payload } = await call(routes, READ_PATH, { op: 'file', path: '../outside/secret.md',
    })
    assert.equal(status, 400)
    assert.equal(payload.error, 'outside_root')
  })

  it('refuses a symlink escape on read', async () => {
    const { status, payload } = await call(routes, READ_PATH, { op: 'file', path: 'escape/secret.md',
    })
    assert.equal(status, 400)
    assert.equal(payload.error, 'outside_root')
  })

  it('refuses a non-markdown read', async () => {
    const { status, payload } = await call(routes, READ_PATH, { op: 'file', path: 'note.txt',
    })
    assert.equal(status, 400)
    assert.equal(payload.error, 'wrong_extension')
  })

  it('reports a missing file as not found', async () => {
    const { status, payload } = await call(routes, READ_PATH, { op: 'file', path: 'decisions/gone.md',
    })
    assert.equal(status, 404)
    assert.equal(payload.error, 'not_found')
  })

  it('refuses a read above the size bound', async () => {
    await writeFile(join(memoryRoot, 'big.md'), 'x'.repeat(5000))
    const { status, payload } = await call(routes, READ_PATH, { op: 'file', path: 'big.md',
    })
    assert.equal(status, 413)
    assert.equal(payload.error, 'too_large')
  })

  it('writes a new file and reads it back', async () => {
    const write = await call(routes, MUTATE_PATH, { op: 'write', path: 'decisions/new.md' },
      { text: '# new\n' })
    assert.equal(write.status, 200)
    assert.equal(await readFile(join(memoryRoot, 'decisions', 'new.md'), 'utf8'), '# new\n')
  })

  it('creates missing parent directories on write', async () => {
    const { status } = await call(routes, MUTATE_PATH, { op: 'write', path: 'deep/nested/note.md',
    }, { text: 'nested\n' })
    assert.equal(status, 200)
    assert.equal(await readFile(join(memoryRoot, 'deep', 'nested', 'note.md'), 'utf8'), 'nested\n')
  })

  it('refuses a traversal on write and leaves the target untouched', async () => {
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'write', path: '../outside/planted.md',
    }, { text: 'planted\n' })
    assert.equal(status, 400)
    assert.equal(payload.error, 'outside_root')
    await assert.rejects(() => readFile(join(base, 'outside', 'planted.md'), 'utf8'))
  })

  it('refuses a symlink escape on write', async () => {
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'write', path: 'escape/planted.md',
    }, { text: 'planted\n' })
    assert.equal(status, 400)
    assert.equal(payload.error, 'outside_root')
    await assert.rejects(() => readFile(join(base, 'outside', 'planted.md'), 'utf8'))
  })

  it('refuses to write a non-markdown file', async () => {
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'write', path: 'evil.sh',
    }, { text: 'rm -rf /\n' })
    assert.equal(status, 400)
    assert.equal(payload.error, 'wrong_extension')
  })

  it('refuses a write above the size bound', async () => {
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'write', path: 'huge.md',
    }, { text: 'x'.repeat(5000) })
    assert.equal(status, 413)
    assert.equal(payload.error, 'too_large')
  })

  it('refuses a write with no text field', async () => {
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'write', path: 'x.md',
    }, { content: 'wrong key' })
    assert.equal(status, 400)
    assert.equal(payload.error, 'invalid_body')
  })

  it('creates a directory', async () => {
    const { status } = await call(routes, MUTATE_PATH, { op: 'mkdir', path: 'fresh',
    }, {})
    assert.equal(status, 200)
  })

  it('refuses to delete a root', async () => {
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'delete', path: '',
    }, {})
    assert.equal(status, 400)
    assert.equal(payload.error, 'wrong_kind')
  })

  it('deletes a file', async () => {
    await writeFile(join(memoryRoot, 'doomed.md'), 'bye\n')
    const { status } = await call(routes, MUTATE_PATH, { op: 'delete', path: 'doomed.md',
    }, {})
    assert.equal(status, 200)
    await assert.rejects(() => readFile(join(memoryRoot, 'doomed.md'), 'utf8'))
  })

  it('refuses to delete outside the root', async () => {
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'delete', path: '../outside/secret.md',
    }, {})
    assert.equal(status, 400)
    assert.equal(payload.error, 'outside_root')
    assert.equal(await readFile(join(base, 'outside', 'secret.md'), 'utf8'), '# secret\n')
  })

  it('refuses to delete a non-markdown file', async () => {
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'delete', path: 'note.txt',
    }, {})
    assert.equal(status, 400)
    assert.equal(payload.error, 'wrong_extension')
    assert.equal(await readFile(join(memoryRoot, 'note.txt'), 'utf8'), 'not markdown\n')
  })

  it('lists a directory whose name ends in .md as a directory, not a file', async () => {
    await mkdir(join(memoryRoot, 'folder.md'))
    const { payload } = await call(routes, READ_PATH, { op: 'tree' })
    const node = payload.children.find(candidate => candidate.name === 'folder.md')
    assert.equal(node?.type, 'dir')
  })

  it('deletes a directory whose name ends in .md', async () => {
    const { status } = await call(routes, MUTATE_PATH, { op: 'delete', path: 'folder.md',
    }, {})
    assert.equal(status, 200)
    await assert.rejects(() => stat(join(memoryRoot, 'folder.md')))
  })

  it('deletes a folder together with the notes inside it', async () => {
    await mkdir(join(memoryRoot, 'topic', 'nested'), { recursive: true })
    await writeFile(join(memoryRoot, 'topic', 'note.md'), '# note\n')
    await writeFile(join(memoryRoot, 'topic', 'nested', 'deep.md'), '# deep\n')
    const { status } = await call(routes, MUTATE_PATH, { op: 'delete', path: 'topic',
    }, {})
    assert.equal(status, 200)
    await assert.rejects(() => stat(join(memoryRoot, 'topic')))
  })

  it('refuses to delete a folder holding an unlisted file', async () => {
    await mkdir(join(memoryRoot, 'mixed'), { recursive: true })
    await writeFile(join(memoryRoot, 'mixed', 'note.md'), '# note\n')
    await writeFile(join(memoryRoot, 'mixed', 'raw.txt'), 'raw\n')
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'delete', path: 'mixed',
    }, {})
    assert.equal(status, 400)
    assert.equal(payload.error, 'unlisted_content')
    assert.equal((await stat(join(memoryRoot, 'mixed'))).isDirectory(), true)
    await rm(join(memoryRoot, 'mixed'), { recursive: true, force: true })
  })

  it('refuses to delete a folder holding a hidden entry', async () => {
    await mkdir(join(memoryRoot, 'hidden-inside'), { recursive: true })
    await writeFile(join(memoryRoot, 'hidden-inside', '.secret.md'), '# secret\n')
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'delete', path: 'hidden-inside',
    }, {})
    assert.equal(status, 400)
    assert.equal(payload.error, 'unlisted_content')
    await rm(join(memoryRoot, 'hidden-inside'), { recursive: true, force: true })
  })

  it('refuses to delete a folder holding a skipped directory', async () => {
    await mkdir(join(memoryRoot, 'with-deps', 'node_modules'), { recursive: true })
    await writeFile(join(memoryRoot, 'with-deps', 'node_modules', 'dep.md'), '# dep\n')
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'delete', path: 'with-deps',
    }, {})
    assert.equal(status, 400)
    assert.equal(payload.error, 'unlisted_content')
    await rm(join(memoryRoot, 'with-deps'), { recursive: true, force: true })
  })

  it('refuses to delete a folder holding a symbolic link', async () => {
    await mkdir(join(memoryRoot, 'linked'), { recursive: true })
    await symlink(join(base, 'outside', 'secret.md'), join(memoryRoot, 'linked', 'link.md'))
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'delete', path: 'linked',
    }, {})
    assert.equal(status, 400)
    assert.equal(payload.error, 'unlisted_content')
    assert.equal(await readFile(join(base, 'outside', 'secret.md'), 'utf8'), '# secret\n')
    await rm(join(memoryRoot, 'linked'), { recursive: true, force: true })
  })

  it('refuses to delete a hidden folder', async () => {
    await mkdir(join(memoryRoot, '.hidden'), { recursive: true })
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'delete', path: '.hidden',
    }, {})
    assert.equal(status, 400)
    assert.equal(payload.error, 'wrong_kind')
    assert.equal((await stat(join(memoryRoot, '.hidden'))).isDirectory(), true)
    await rm(join(memoryRoot, '.hidden'), { recursive: true, force: true })
  })

  it('refuses to delete a skipped directory', async () => {
    await mkdir(join(memoryRoot, 'node_modules'), { recursive: true })
    const { status, payload } = await call(routes, MUTATE_PATH, { op: 'delete', path: 'node_modules',
    }, {})
    assert.equal(status, 400)
    assert.equal(payload.error, 'wrong_kind')
    assert.equal((await stat(join(memoryRoot, 'node_modules'))).isDirectory(), true)
    await rm(join(memoryRoot, 'node_modules'), { recursive: true, force: true })
  })

  it('refuses to decode invalid UTF-8', async () => {
    await writeFile(join(memoryRoot, 'invalid.md'), Buffer.from([0x23, 0x20, 0xff, 0x0a]))
    const { status, payload } = await call(routes, READ_PATH, { op: 'file', path: 'invalid.md',
    })
    assert.equal(status, 400)
    assert.equal(payload.error, 'invalid_encoding')
  })

  it('reports paths relative to the canonical root when the root is a symlink', async () => {
    // The panel saves to the path a read returned, so a path measured against
    // the configured (uncanonicalized) root would write to a different file.
    const linkedRoot = join(base, 'memory-link')
    await symlink(memoryRoot, linkedRoot)
    const linkedRoutes = buildRoutes({
      enabled: true,
      root: linkedRoot,
      maxDepth: 5,
      maxFileBytes: 4096,
    })
    const read = await call(linkedRoutes, READ_PATH, { op: 'file', path: 'decisions/a.md',
    })
    assert.equal(read.status, 200)
    assert.equal(read.payload.path, 'decisions/a.md')
    const write = await call(linkedRoutes, MUTATE_PATH, { op: 'write', path: 'decisions/a.md',
    }, { text: '# changed\n' })
    assert.equal(write.status, 200)
    assert.equal(write.payload.path, 'decisions/a.md')
    assert.equal(await readFile(join(memoryRoot, 'decisions', 'a.md'), 'utf8'), '# changed\n')
    await writeFile(join(memoryRoot, 'decisions', 'a.md'), '# a\n')
  })
})
