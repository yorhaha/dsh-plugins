/**
 * Synthetic export batches for the offline checks.
 *
 * The shape follows what the exporter writes: `export_meta.json` last, one JSONL
 * file per conversation, a directory per conversation holding its images, and
 * the optional enrichment fields a group export produces.
 *
 * @module dsh-wechat/tests/fixture
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A one-pixel PNG, so an image reference resolves to real bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * One exporter record with every required field.
 * @param overrides - Fields to replace.
 * @returns the record.
 */
export function record(overrides = {}) {
  return {
    timestamp: 1791526400,
    datetime: '2026-10-09T14:13:20',
    chat_id: 'alice-id',
    chat_name: 'Alice',
    msg_type: 1,
    msg_type_label: 'text',
    is_group: false,
    real_sender_id: 5,
    is_self: false,
    direction: 'inbound',
    sender_id: 'wxid_alice',
    sender_name: 'Alice',
    content: '你好，明天的会议改到三点',
    ...overrides,
  }
}

/** The private conversation's records, in file order. */
export const ALICE_RECORDS = [
  record(),
  record({
    timestamp: 1791526460,
    datetime: '2026-10-09T14:14:20',
    is_self: true,
    direction: 'outbound',
    sender_id: 'wxid_self',
    sender_name: '我',
    content: '收到，三点见',
  }),
  record({
    timestamp: 1791526520,
    datetime: '2026-10-09T14:15:20',
    msg_type: 3,
    msg_type_label: 'image',
    content: '',
    image_file: '123456.png',
    ocr_text: '发票 金额 128 元',
  }),
  record({
    timestamp: 1791526580,
    datetime: '2026-10-09T14:16:20',
    msg_type: 34,
    msg_type_label: 'voice',
    content: '',
    voice_meta: { length: 3, format: 'silk' },
    voice_transcription: '好的，没问题',
  }),
  record({
    timestamp: 1791526640,
    datetime: '2026-10-09T14:17:20',
    msg_type: 49,
    msg_type_label: 'quote',
    content: '这个方案我同意',
    quote_sender_name: 'Alice',
    quote_sender_id: 'wxid_alice',
    quote_content: '明天的会议改到三点',
  }),
  record({
    timestamp: 1791526700,
    datetime: '2026-10-09T14:18:20',
    msg_type: 1,
    msg_type_label: 'text',
    local_id: 987654,
    content: '这条记录带 local_id',
  }),
  // The same fingerprint twice: the second one is the collision the importer
  // records and keeps, rather than silently dropping it.
  record({ timestamp: 1791526760, datetime: '2026-10-09T14:19:20', content: '重复的一条' }),
  record({ timestamp: 1791526760, datetime: '2026-10-09T14:19:20', content: '重复的一条' }),
]

/** The group conversation's records. */
export const GROUP_RECORDS = [
  record({
    timestamp: 1791527400,
    datetime: '2026-10-09T14:30:00',
    chat_id: 'group-id',
    chat_name: '群聊A',
    is_group: true,
    msg_type_label: 'text',
    sender_id: 'wxid_bob',
    sender_name: 'Bob',
    content: '群里的消息，默认不导入',
  }),
  record({
    timestamp: 1791527460,
    datetime: '2026-10-09T14:31:00',
    chat_id: 'group-id',
    chat_name: '群聊A',
    is_group: true,
    msg_type_label: 'text',
    sender_id: 'wxid_carol',
    sender_name: 'Carol',
    content: '另一条群消息',
  }),
]

/**
 * Write a complete batch directory.
 *
 * @param root - Directory to create the batch in.
 * @param options - Fixture options.
 * @param options.name - Batch directory name.
 * @param options.alice - Private records; defaults to {@link ALICE_RECORDS}.
 * @param options.group - Group records; defaults to {@link GROUP_RECORDS}.
 * @param options.meta - `export_meta.json` overrides.
 * @param options.omitMeta - Write no `export_meta.json` at all.
 * @param options.dropJsonl - Remove the conversation files after writing them.
 * @returns the batch directory.
 */
export function writeBatch(root, options = {}) {
  const name = options.name ?? 'wechat-test-full'
  const dir = join(root, name)
  mkdirSync(join(dir, 'Alice', 'images'), { recursive: true })
  mkdirSync(join(dir, '群聊A'), { recursive: true })
  const alice = options.alice ?? ALICE_RECORDS
  const group = options.group ?? GROUP_RECORDS
  writeJsonl(join(dir, 'Alice.jsonl'), alice)
  writeJsonl(join(dir, '群聊A.jsonl'), group)
  if (options.splitChat === true) writeJsonl(join(dir, 'Alice-2.jsonl'), [alice[0]])
  writeFileSync(join(dir, 'Alice', 'images', '123456.png'), PNG)
  writeFileSync(join(dir, '群聊A', '_voice_map.json'), JSON.stringify({ version: 1, voices: {} }))
  if (options.dropJsonl === true) {
    rmSync(join(dir, 'Alice.jsonl'), { force: true })
    rmSync(join(dir, '群聊A.jsonl'), { force: true })
  }
  if (options.omitMeta !== true) {
    const total = alice.length + group.length + (options.splitChat === true ? 1 : 0)
    const meta = {
      export_time: '2026-10-11T14:54:33.191409',
      time_range: { start: null, end: null },
      shards_processed: ['message_0.db'],
      total_messages: total,
      total_text_messages: alice.filter((item) => item.msg_type_label === 'text').length,
      chat_count: 2,
      chats_exported: ['Alice', '群聊A'],
      self_sender_id: 2,
      per_chat_files: true,
      ...options.meta,
    }
    writeFileSync(join(dir, 'export_meta.json'), JSON.stringify(meta, null, 2))
  }
  return dir
}

/**
 * Write records as JSONL.
 * @param path - Destination file.
 * @param records - Records to write.
 */
function writeJsonl(path, records) {
  writeFileSync(path, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`)
}

/**
 * The errors a caller can expect from a batch that must be refused.
 * @returns one entry per broken batch: name, the change to apply, and its code.
 */
export function brokenBatches() {
  return [
    {
      name: 'count-mismatch',
      code: 'batch_invalid',
      meta: { total_messages: 99 },
    },
    {
      name: 'chat-count-mismatch',
      code: 'batch_invalid',
      meta: { chat_count: 7 },
    },
    {
      name: 'missing-field',
      code: 'batch_invalid',
      mutate: (records) => [{ ...records[0], content: undefined }],
      alice: true,
    },
    {
      name: 'bad-direction',
      code: 'batch_invalid',
      mutate: (records) => [{ ...records[0], direction: 'sideways' }],
      alice: true,
    },
    {
      name: 'mixed-chat',
      code: 'batch_invalid',
      mutate: (records) => [records[0], { ...records[1], chat_id: 'other-id' }],
      alice: true,
    },
    {
      name: 'dangling-image',
      code: 'batch_invalid',
      mutate: (records) => [records[0], { ...records[2], image_file: 'nope.png' }],
      alice: true,
    },
    {
      name: 'image-traversal',
      code: 'batch_invalid',
      mutate: (records) => [records[0], { ...records[2], image_file: '../../etc/passwd' }],
      alice: true,
    },
    {
      name: 'bad-meta-time',
      code: 'batch_invalid',
      meta: { export_time: 'yesterday' },
    },
    {
      name: 'no-jsonl',
      code: 'batch_invalid',
      dropJsonl: true,
    },
    {
      name: 'split-chat',
      code: 'batch_invalid',
      splitChat: true,
    },
    {
      name: 'incomplete',
      code: 'batch_incomplete',
      omitMeta: true,
    },
  ]
}
