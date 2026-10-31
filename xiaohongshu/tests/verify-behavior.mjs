/**
 * Offline behaviour checks for the Xiaohongshu bundle.
 *
 * Everything here runs against scripted fetch responses and a temporary
 * SQLite file; no real cookie or upstream request is involved. The tool
 * definitions' output schemas are validated against the harness's supported
 * JSON Schema subset, so a field added to a tool value without its schema fails
 * here before a model ever sees it.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { XhsClient } from '../src/client.js'
import { resolveConfig } from '../src/config.js'
import { CookieError, describeCookie, parseCookie } from '../src/cookie.js'
import { createDeviceProfile, signMainApi } from '../src/signing.js'
import { countOf, noteUrl, searchNotesFrom } from '../src/mapping.js'
import { openStore } from '../src/store.js'
import { buildTools } from '../src/tools.js'

let passed = 0
let failed = 0

/**
 * Run one named check.
 * @param name - check name.
 * @param body - the check.
 */
async function check(name, body) {
  try {
    await body()
    passed += 1
    console.log(`ok    ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}: ${error?.message ?? error}`)
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), 'xhs-tests-'))
const store = await openStore({
  databasePath: join(tempRoot, 'xhs.db'),
  mediaRoot: join(tempRoot, 'media'),
})

const config = resolveConfig({ toolTimeoutMs: 120_000 })
config.minIntervalMs = 0
config.downloadMedia = false

const values = { a1: 'a1-test-value', web_session: 'session-test-value', webId: 'web-id-test' }
const device = createDeviceProfile(values, config.userAgent)
const credential = {
  cookie: `a1=${values.a1}; web_session=${values.web_session}; webId=${values.webId}`,
  values,
  device,
  saved_at: '2026-10-31T00:00:00Z',
  account: { user_id: 'u1', nickname: '测试账号', avatar_url: null, red_id: 'red1' },
}

const snapshot = { fetched_at: '2026-10-31T04:00:00Z', cached: false, cache_age_seconds: 0 }
const note = {
  note_id: 'note12345678',
  type: 'normal',
  title: '露营装备清单',
  body: '周末去露营，带上帐篷、天幕和折叠椅。',
  author: { user_id: 'u2', nickname: '作者甲', avatar_url: null },
  tags: ['露营', '户外'],
  images: [{ url: 'https://example.com/a.jpg', width: 1080, height: 1440 }],
  video_url: null,
  cover_url: 'https://example.com/cover.jpg',
  published_at: '2026-10-30T10:00:00Z',
  liked_count: 1234,
  collected_count: 234,
  comment_count: 56,
  share_count: 7,
  ip_location: '上海',
  xsec_token: 'token-abc',
  xsec_source: 'pc_search',
  url: noteUrl('note12345678', 'token-abc'),
}
const comment = {
  comment_id: 'comment1',
  parent_comment_id: null,
  author: { user_id: 'u3', nickname: '评论者', avatar_url: null },
  content: '帐篷在哪里买的？',
  like_count: 8,
  created_at: '2026-10-30T12:00:00Z',
  sub_comment_count: 0,
}
const user = {
  user_id: 'u2',
  nickname: '作者甲',
  red_id: 'red2',
  description: '记录露营',
  avatar_url: null,
  gender: null,
  ip_location: '上海',
  follower_count: 100,
  following_count: 20,
  note_count: 30,
  liked_count: 200,
  url: 'https://www.xiaohongshu.com/user/profile/u2',
}

await check('config defaults are slow and explicit', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.minIntervalMs, 12_000)
  assert.equal(defaults.hourlyBudget, 20)
  assert.equal(defaults.searchHourlyBudget, 6)
  assert.equal(defaults.downloadMedia, true)
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key/)
  assert.throws(() => resolveConfig({ searchHourlyBudget: 30 }), /must not exceed/)
})

await check('cookie parser requires a1 and web_session and keeps all fields', () => {
  const parsed = parseCookie('a1=one; web_session=two; webId=three; a1=ignored')
  assert.equal(parsed.values.a1, 'one')
  assert.equal(parsed.values.web_session, 'two')
  assert.equal(parsed.values.webId, 'three')
  assert.equal(parsed.header.includes('a1=one'), true)
  assert.throws(() => parseCookie('a1=one'), (error) => error instanceof CookieError && error.code === 'cookie_invalid')
  assert.throws(() => parseCookie('a1=one; web_session=two\nX=1'), /line break/)
  assert.equal(describeCookie('a1=one; web_session=two').usable, true)
  assert.equal(describeCookie('a1=one').usable, false)
})

await check('mapping parses localized counts, cards, tokens and URLs', () => {
  assert.equal(countOf('1.2万'), 12_000)
  assert.equal(countOf('3亿'), 300_000_000)
  assert.equal(countOf('1,234'), 1_234)
  const body = {
    data: {
      items: [
        {
          id: 'note12345678',
          xsec_token: 'tok',
          note_card: {
            display_title: '标题',
            user: { user_id: 'u2', nickname: '作者' },
            interact_info: { liked_count: '2.5万', comment_count: '12' },
            cover: { url_default: 'https://example.com/c.jpg' },
          },
        },
      ],
    },
  }
  const notes = searchNotesFrom(body)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].title, '标题')
  assert.equal(notes[0].liked_count, 25_000)
  assert.equal(notes[0].xsec_token, 'tok')
  assert.match(notes[0].url, /xsec_token=tok/)
})

await check('signer emits XYW and XYS with a frozen device profile', () => {
  const params = { num: 20, cursor: '', user_id: 'u1' }
  const xyw = signMainApi('GET', '/api/sns/web/v2/user_posted', values, params, undefined, 1_780_000_000, undefined, 'xyw', device)
  const xyw2 = signMainApi('GET', '/api/sns/web/v2/user_posted', values, params, undefined, 1_780_000_000, undefined, 'xyw', device)
  const xys = signMainApi('POST', '/api/sns/web/v1/search/notes', values, undefined, { keyword: '露营' }, 1_780_000_000, undefined, 'xys', device)
  assert.match(xyw['x-s'], /^XYW_/)
  assert.match(xys['x-s'], /^XYS_/)
  assert.equal(xyw['x-s-common'], xyw2['x-s-common'])
  assert.equal(xyw['x-s'], xyw2['x-s'])
  assert.ok(xyw['x-s-common'].length > 100)
  assert.ok(xyw['x-t'].length > 0)
})

await check('store keeps body through a card update and searches Chinese text', () => {
  store.upsertNote(note, { capturedAt: '2026-10-31T04:00:00Z' })
  store.upsertNote({ ...note, body: null, title: '露营装备清单（更新）' }, { capturedAt: '2026-10-31T04:00:01Z' })
  store.insertComments(note.note_id, [comment])
  const found = store.searchNotes({ query: '帐篷', limit: 10, offset: 0 })
  assert.equal(found.total, 1)
  assert.equal(found.notes[0].title, '露营装备清单（更新）')
  assert.equal(found.notes[0].content_chars > 0, true)
  assert.equal(store.searchNotes({ query: '不存在', limit: 10, offset: 0 }).total, 0)
  assert.equal(store.getNote(note.note_id).comments.length, 1)
})

await check('client serializes, caches, falls back from 406 and pauses on 461', async () => {
  let calls = 0
  let formats = []
  const fetchImpl = async (url, init) => {
    calls += 1
    formats.push(init.headers['x-s'].slice(0, 4))
    const path = new URL(url).pathname
    if (calls === 1) return new Response('{}', { status: 406 })
    let data
    if (path.endsWith('/user/me')) data = { user_id: 'u1', nickname: '测试账号' }
    else if (path.endsWith('/search/notes')) data = { items: [] }
    else data = {}
    return new Response(JSON.stringify({ success: true, code: 0, data }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new XhsClient({ config, readCredential: async () => credential, fetchImpl })
  const result = await client.search({ query: '露营' })
  assert.equal(calls, 2)
  assert.equal(formats[0], 'XYS_')
  assert.equal(formats[1], 'XYW_')
  assert.equal(result.notes.length, 0)

  const blocked = new XhsClient({
    config,
    readCredential: async () => credential,
    fetchImpl: async () => new Response('{}', { status: 461, headers: { verifytype: '1' } }),
  })
  await assert.rejects(() => blocked.verify({ fresh: true }), (error) => error.code === 'risk_control')
  assert.notEqual(blocked.stats().paused_until, null)
})

const mockClient = {
  verify: async () => ({ account: credential.account, snapshot }),
  search: async ({ query }) => ({ query, page: 1, notes: [note], has_more: false, snapshot }),
  note: async () => ({ note, snapshot }),
  comments: async () => ({ comments: [comment], cursor: '', has_more: false, snapshot }),
  user: async () => ({ user, snapshot }),
  userNotes: async () => ({ notes: [note], cursor: '', has_more: false, snapshot }),
}

const tools = buildTools({
  client: mockClient,
  store,
  config,
  connect: async () => ({ account: credential.account, saved_at: credential.saved_at }),
  disconnect: async () => {},
  jobs: undefined,
  logger: { warn: () => {} },
})

/** Find one built tool. */
const tool = (name) => tools.find((candidate) => candidate.name === name)

/** Execute one tool and validate its schema. */
async function runTool(name, args) {
  const definition = tool(name)
  assert.ok(definition, `${name} is registered`)
  assertSupportedJsonSchema(definition.parameters)
  assertSupportedJsonSchema(definition.output.schema)
  const value = await definition.execute(args, {})
  const violations = validateJsonSchemaValue(definition.output.schema, value, 'value')
  assert.deepEqual(violations, [], `${name}: ${violations.join('; ')}`)
  return value
}

await check('all tool definitions have supported schemas', () => {
  assert.equal(tools.length, 10)
  for (const definition of tools) {
    assertSupportedJsonSchema(definition.parameters)
    assertSupportedJsonSchema(definition.output.schema)
  }
})

await check('xhs_connect and xhs_me return the account', async () => {
  const connected = await runTool('xhs_connect', { cookie: credential.cookie })
  assert.equal(connected.account.nickname, '测试账号')
  const me = await runTool('xhs_me', {})
  assert.equal(me.account.user_id, 'u1')
})

await check('xhs_search returns note cards', async () => {
  const value = await runTool('xhs_search', { query: '露营', sort: 'popularity', note_type: 'image', limit: 5 })
  assert.equal(value.returned_count, 1)
  assert.equal(value.items[0].liked_count, 1234)
})

await check('xhs_note returns the body, images and comments', async () => {
  const value = await runTool('xhs_note', { note_id: 'note12345678', include_comments: true })
  assert.equal(value.note.content, note.body)
  assert.equal(value.note.images.length, 1)
  assert.equal(value.comments.length, 1)
})

await check('xhs_comments and xhs_user return their rows', async () => {
  const comments = await runTool('xhs_comments', { note_id: note.note_id, limit: 5 })
  assert.equal(comments.returned_count, 1)
  const profile = await runTool('xhs_user', { user_id: 'u2abcdefgh', include_notes: true })
  assert.equal(profile.user.nickname, '作者甲')
  assert.equal(profile.notes.length, 1)
})

await check('xhs_capture writes the corpus and the local tools read it', async () => {
  const captured = await runTool('xhs_capture', { query: '露营', detail_limit: 1 })
  assert.equal(captured.status, 'completed')
  assert.equal(captured.summary.cards, 1)
  const found = await runTool('xhs_corpus_search', { query: '帐篷' })
  assert.equal(found.total >= 1, true)
  const item = await runTool('xhs_item', { note_id: note.note_id })
  assert.equal(item.item.note.note_id, note.note_id)
})

store.close()
rmSync(tempRoot, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
