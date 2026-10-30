/**
 * Config validation and injected-text tests.
 *
 * Config defects must fail the load. A memory root that silently fell back to a
 * default would point the browser at a directory the user never chose, which is
 * worse than refusing to start. A RELATIVE root is such a defect: it resolves
 * against whichever directory launched the harness, so `dsh web` from a checkout
 * and the desktop application would read different memory directories from the
 * same configuration.
 *
 * The guidance assertions pin the properties the design depends on: the text is
 * a pure function of the root (so the prompt never changes between turns), it
 * lists no memories (so it cannot go stale), and it tells the model that the
 * user writes the same files (so the model does not treat them as its own).
 *
 * @module dsh-file-memory/tests/config-guidance
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { DEFAULTS, defaultRoot, resolveConfig } from '../src/config.js'
import { memoryGuidance } from '../src/guidance.js'

describe('resolveConfig', () => {
  it('supplies every default for an absent row', () => {
    const config = resolveConfig(undefined)
    assert.equal(config.enabled, true)
    assert.equal(config.root, defaultRoot())
    assert.equal(config.maxDepth, DEFAULTS.maxDepth)
    assert.equal(config.maxFileBytes, DEFAULTS.maxFileBytes)
  })

  it('resolves the root to an absolute path', () => {
    assert.equal(isAbsolute(resolveConfig(undefined).root), true)
  })

  it('expands a leading tilde', () => {
    assert.equal(resolveConfig({ root: '~/mem' }).root, join(homedir(), 'mem'))
    assert.equal(resolveConfig({ root: '~' }).root, homedir())
  })

  it('leaves an absolute path alone', () => {
    assert.equal(resolveConfig({ root: '/tmp/mem' }).root, '/tmp/mem')
  })

  it('refuses an unknown key rather than ignoring it', () => {
    // The two-root keys are gone; a leftover row must fail loudly rather than
    // leave the plugin on a default root the deployment never chose.
    assert.throws(() => resolveConfig({ root: '/tmp/x', userRoot: '/tmp/y' }), { name: 'TypeError' })
    assert.throws(() => resolveConfig({ projectRoot: '/tmp/x' }), { name: 'TypeError' })
  })

  it('refuses an empty root', () => {
    assert.throws(() => resolveConfig({ root: '   ' }), { name: 'TypeError' })
  })

  it('refuses a relative root rather than resolving it against the launch directory', () => {
    // The spelling that used to be the default is now the headline defect: it
    // means a different directory per launcher.
    for (const root of ['.dsh/memory', 'memory', './memory', '../memory']) {
      assert.throws(() => resolveConfig({ root }), { name: 'TypeError' }, `accepted ${root}`)
    }
  })

  it('refuses a non-string root', () => {
    assert.throws(() => resolveConfig({ root: 7 }), { name: 'TypeError' })
  })

  it('refuses a non-boolean enabled', () => {
    assert.throws(() => resolveConfig({ enabled: 'yes' }), { name: 'TypeError' })
  })

  it('refuses an out-of-range bound', () => {
    assert.throws(() => resolveConfig({ maxDepth: 0 }), { name: 'TypeError' })
    assert.throws(() => resolveConfig({ maxDepth: 33 }), { name: 'TypeError' })
    assert.throws(() => resolveConfig({ maxFileBytes: 2.5 }), { name: 'TypeError' })
  })

  it('refuses a non-mapping config', () => {
    assert.throws(() => resolveConfig([1, 2]), { name: 'TypeError' })
  })

})

describe('defaultRoot', () => {
  const savedHome = process.env.DSH_HOME
  const launchDirectory = process.cwd()

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    process.chdir(launchDirectory)
  })

  it('sits under the Harness home', () => {
    delete process.env.DSH_HOME
    assert.equal(defaultRoot(), join(homedir(), '.dsh', 'memory'))
  })

  it('follows $DSH_HOME', () => {
    process.env.DSH_HOME = '/tmp/dsh-home'
    assert.equal(defaultRoot(), join('/tmp/dsh-home', 'memory'))
  })

  it('treats a blank $DSH_HOME as unset, never as the working directory', () => {
    process.env.DSH_HOME = '   '
    assert.equal(defaultRoot(), join(homedir(), '.dsh', 'memory'))
  })

  it('names the same directory whatever directory launched the process', () => {
    // The whole point of the default: the launcher is not the workspace, so the
    // default must not be a function of it.
    delete process.env.DSH_HOME
    const expected = defaultRoot()
    const elsewhere = mkdtempSync(join(tmpdir(), 'file-memory-launch-'))
    process.chdir(elsewhere)
    assert.equal(defaultRoot(), expected)
  })
})

describe('memoryGuidance', () => {
  const root = '/tmp/memory'

  it('names the root', () => {
    assert.ok(memoryGuidance(root).includes(root))
  })

  it('is a pure function of the root, so the prompt never changes', () => {
    assert.equal(memoryGuidance(root), memoryGuidance(root))
  })

  it('lists no individual memories', () => {
    // An entry list would look like "- `path/to/file.md`: summary". The text
    // does mention `.md` inside the glob example, which is not a listing.
    assert.equal(/^-\s+`[^`]*\.md`/m.test(memoryGuidance(root)), false)
  })

  it('teaches the synonym retry that lexical search needs', () => {
    assert.match(memoryGuidance(root), /synonym/)
  })

  it('tells the model not to maintain an index file', () => {
    assert.match(memoryGuidance(root), /index file/)
  })

  it('says the user writes the same files, so neither side assumes ownership', () => {
    const text = memoryGuidance(root)
    assert.match(text, /Both you and the user can read and write it/)
    assert.match(text, /Read a file before modifying it/)
  })

  it('stays within a bounded token budget', () => {
    // A generous ceiling that still catches accidental growth into a listing.
    assert.ok(memoryGuidance(root).length < 1200, `too long: ${memoryGuidance(root).length}`)
  })
})
