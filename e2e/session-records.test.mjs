import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { eventOf, readAssistantTexts, readSessionRecords } from './lib.mjs'

const SESSION_ID = 'session-native-frames'

function line(value) {
  return `${JSON.stringify(value)}\n`
}

function sessionHeader(id = SESSION_ID) {
  return { type: 'session', id }
}

function assistantEvent(text) {
  return {
    type: 'event',
    event: {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    },
  }
}

function humanEvent(text) {
  return { type: 'event', event: { type: 'human/message', data: { text } } }
}

/** 用真实 zstdCompressSync 生成一帧；多条记录之间用换行分隔。 */
function frame(...records) {
  return zstdCompressSync(Buffer.from(records.map(line).join(''), 'utf8'))
}

async function withHome(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'taktflow-session-reader-'))
  try {
    await mkdir(path.join(home, 'sessions', 'project'), { recursive: true })
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

async function writeSession(home, name, contents) {
  await writeFile(path.join(home, 'sessions', 'project', name), contents)
}

test('多帧 zstd：第一帧只有 header 时也按顺序读取全部后续帧', async () => {
  await withHome(async (home) => {
    const raw = Buffer.concat([
      frame(sessionHeader()),
      frame(humanEvent('需求')),
      frame(assistantEvent('第一段'), assistantEvent('第二段')),
      frame(assistantEvent('第三段')),
    ])
    await writeSession(home, `${SESSION_ID}.jsonl.zstd`, raw)

    const records = await readSessionRecords(home, SESSION_ID)
    assert.equal(records.length, 4)
    assert.deepEqual(records.map((record) => record.event.type), [
      'human/message',
      'assistant/message',
      'assistant/message',
      'assistant/message',
    ])
    assert.deepEqual(await readAssistantTexts(home, SESSION_ID), ['第一段', '第二段', '第三段'])
  })
})

test('单帧 zstd：header 与事件在同一帧时行为不变', async () => {
  await withHome(async (home) => {
    await writeSession(
      home,
      `${SESSION_ID}.jsonl.zstd`,
      frame(sessionHeader(), humanEvent('需求'), assistantEvent('回答')),
    )

    const records = await readSessionRecords(home, SESSION_ID)
    assert.equal(records.length, 2)
    assert.deepEqual(await readAssistantTexts(home, SESSION_ID), ['回答'])
  })
})

test('纯 JSONL：未压缩日志行为不变', async () => {
  await withHome(async (home) => {
    await writeSession(
      home,
      `${SESSION_ID}.jsonl`,
      Buffer.from([sessionHeader(), humanEvent('需求'), assistantEvent('回答')].map(line).join(''), 'utf8'),
    )

    const records = await readSessionRecords(home, SESSION_ID)
    assert.equal(records.length, 2)
    assert.deepEqual(await readAssistantTexts(home, SESSION_ID), ['回答'])
  })
})

test('第一帧无效：整个文件跳过，不产生事件', async () => {
  await withHome(async (home) => {
    await writeSession(
      home,
      `${SESSION_ID}.jsonl.zstd`,
      Buffer.concat([
        Buffer.from('这不是 zstd 帧'),
        frame(sessionHeader()),
        frame(assistantEvent('不应出现')),
      ]),
    )

    assert.deepEqual(await readSessionRecords(home, SESSION_ID), [])
  })
})

test('末尾不完整帧：返回已完整解码的前缀，不虚构事件', async () => {
  await withHome(async (home) => {
    const complete = frame(assistantEvent('已写入'))
    const tail = frame(assistantEvent('未完成'))
    const truncated = tail.subarray(0, tail.length - 1)
    assert.ok(truncated.length < tail.length)

    await writeSession(
      home,
      `${SESSION_ID}.jsonl.zstd`,
      Buffer.concat([frame(sessionHeader()), complete, truncated]),
    )

    const records = await readSessionRecords(home, SESSION_ID)
    assert.equal(records.length, 1)
    assert.deepEqual(await readAssistantTexts(home, SESSION_ID), ['已写入'])

    // 日志继续增长：不完整帧写完后，下一次读取能看到它。
    await writeSession(
      home,
      `${SESSION_ID}.jsonl.zstd`,
      Buffer.concat([frame(sessionHeader()), complete, tail]),
    )
    assert.deepEqual(await readAssistantTexts(home, SESSION_ID), ['已写入', '未完成'])
  })
})

test('会话 id 过滤：只读取 header 匹配的文件', async () => {
  await withHome(async (home) => {
    await writeSession(
      home,
      'other-session.jsonl.zstd',
      frame(sessionHeader('other-session'), assistantEvent('其他会话')),
    )
    await writeSession(
      home,
      `${SESSION_ID}.jsonl.zstd`,
      frame(sessionHeader(), assistantEvent('目标会话')),
    )

    const records = await readSessionRecords(home, SESSION_ID)
    assert.equal(records.length, 1)
    assert.deepEqual(await readAssistantTexts(home, SESSION_ID), ['目标会话'])
  })
})

test('eventOf：包装与未包装记录的语义不变', () => {
  const inner = { type: 'assistant/message' }
  assert.equal(eventOf({ type: 'event', event: inner }), inner)
  assert.equal(eventOf(inner), inner)
  assert.equal(eventOf(undefined), undefined)
})
