import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { consentSubject, EXPIRED_TEXT, shownMemberName } from '../src/bot/consent.ts'
import { fakeBtn, fileMention, setupBot, textOf, yesOf } from './attachment-bot.ts'

/** Lets the bot's promise chains run; setImmediate is not mocked. */
const settle = async () => {
  for (let n = 0; n < 20; n++) await new Promise((r) => setImmediate(r))
}

const file = (id: string, filename: string) => ({ id, filename, mime_type: 'text/plain', size_bytes: 20 })

describe('consent prompt: whose file and which', () => {
  it('names the asker\'s own file', async () => {
    const t = setupBot()
    await t.emitMessage(fileMention(1, 'u1'))
    assert.match(textOf(t.posted[0]), /^You asked about your file `file\.txt`\. The file will be shared with /)
  })

  it('names the author of a file in the message the question replies to', async () => {
    const t = setupBot({}, {
      getMessage: () => Promise.resolve({ id: 'm0', user_id: 'u2', username: 'bob', display_name: 'Bob', attachments: [file('a0', 'report.txt')] }),
    })
    await t.emitMessage({ id: 'm1', channel_id: 'c1', user_id: 'u1', username: 'alice', mentions: ['bot_id'], content: '<@bot_id> what is in it?', reply_to_id: 'm0', attachments: [] })
    assert.match(textOf(t.posted[0]), /^You asked about `report\.txt`, a file Bob posted\./)
    // Only the asker answers, and the file read is the one named.
    await t.run(fakeBtn(yesOf(t.posted[0]), 'u1').i)
    assert.deepEqual(t.downloadCalls, ['a0'])
  })

  it('says that only the first of several attachments is read', async () => {
    const t = setupBot()
    await t.emitMessage({ ...fileMention(1), attachments: [file('a1', 'one.txt'), file('a2', 'two.txt'), file('a3', 'three.txt')] })
    assert.match(textOf(t.posted[0]), /`one\.txt`\. I read only this one of the 3 attachments on that message\./)
    await t.run(fakeBtn(yesOf(t.posted[0]), 'u1').i)
    assert.deepEqual(t.downloadCalls, ['a1'])
  })

  it('keeps a file name to one short line without code marks', () => {
    const long = `${'x'.repeat(100)}\n\`.txt`
    const text = consentSubject({ attachment: { ...file('a', long), url: '', original_filename: long, is_deleted: false }, ownerId: 'u2', ownerName: 'Bob', total: 1 }, 'u1')
    assert.doesNotMatch(text, /\n/)
    assert.equal(text.split('`').length, 3, 'only the two marks around the name')
    assert.ok(text.length < 140)
  })
})

describe('consent prompt: names as text', () => {
  const subject = (ownerName: string) =>
    consentSubject({ attachment: { ...file('a', 'r.txt'), url: '', original_filename: 'r.txt', is_deleted: false }, ownerId: 'u2', ownerName, total: 1 }, 'u1')

  it('escapes Markdown in the name of whoever posted the file', () => {
    const text = subject('[x](https://e.example) **b**')
    assert.ok(text.includes('\\[\u2060x\\]\\(https\\:\\/\\/e\\.example\\) \\*\\*b\\*\\*'), text)
    assert.doesNotMatch(text, /(?<!\\)\[x(?<!\\)\]/)
  })

  it('keeps the name to one short line', () => {
    const text = subject(`${'B'.repeat(200)}\n<@everyone>`)
    assert.doesNotMatch(text, /\n/)
    assert.doesNotMatch(text, /(?<!\\)</)
    assert.ok(text.length < 200, `length ${text.length}`)
  })

  it('escapes the asker\'s name in the refusal to someone else', async () => {
    const t = setupBot()
    await t.emitMessage({ ...fileMention(1), display_name: '**Al** `ice`' })
    const other = fakeBtn(yesOf(t.posted[0]), 'u9')
    await t.run(other.i)
    assert.equal(textOf(other.sent[0]), 'Only \\*\\*Al\\*\\* \\`ice\\` can answer this.')
  })
})

// Talk's text rules run on text nodes after the escapes are resolved; these
// copies are from mnema-talk web/src/shared/lib/markdown/inline.ts
// (isEscapable), markdown/mentions.ts (userMentionRule, roleMentionRule),
// customEmoji.ts (TOKEN) and wiki/lib/wikiLinks.ts.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const TALK_TEXT_RULES = [
  /(^|[\s(])@([A-Za-z0-9_.-]{2,32})/g,
  /(^|[\s(])@(alice|all|here|moderators)(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])/gi,
  new RegExp(`<:([a-z0-9_]{2,32}):(${UUID})>`, 'g'),
  /\[\[([^[\]|\n]{1,100})(?:\|([^[\]\n]{1,100}))?\]\]/g,
]
const unescaped = (s: string) => s.replace(/\\([^0-9A-Za-z\s])/g, '$1')

describe('consent prompt: names and Talk\'s text rules', () => {
  const subject = (ownerName: string) =>
    consentSubject({ attachment: { ...file('a', 'r.txt'), url: '', original_filename: 'r.txt', is_deleted: false }, ownerId: 'u2', ownerName, total: 1 }, 'u1')

  for (const name of ['@all', 'hi @alice', '(@moderators)', '<:wave:0b6c3c2e-1f3a-4d5e-8f90-123456789abc>', '[[Secret page]]']) {
    it(`a name like ${name} becomes no mention, emoji or link`, () => {
      const shown = unescaped(subject(name))
      for (const re of TALK_TEXT_RULES) assert.doesNotMatch(shown, re, `${re.source} in ${shown}`)
    })
  }

  it('cuts a long name between characters, and keeps joined emoji', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    assert.ok(shownMemberName(family).includes('\u200D'))
    const cut = shownMemberName('\u{1F600}'.repeat(100))
    const graphemes = Array.from(new Intl.Segmenter().segment(cut), (g) => g.segment)
    assert.ok(graphemes.every((ch) => ch === '\u{1F600}' || ch === '…'), 'no half of a surrogate pair')
    assert.equal(graphemes.length, 64)
    const families = shownMemberName(family.repeat(80))
    assert.ok(families.endsWith(`${family}…`), 'a joined emoji is not cut apart')
  })
})

describe('consent prompt: expiry', () => {
  it('tells the asker when the question expired, and a late Yes reads nothing', async (ctx) => {
    mock.timers.enable({ apis: ['setTimeout'] })
    ctx.after(() => {
      mock.timers.reset()
    })
    const t = setupBot()
    t.events.emit('messageCreate', fileMention(1))
    await settle()
    const yesId = yesOf(t.posted[0])
    mock.timers.tick(10 * 60_000)
    await settle()
    assert.equal(t.edits.length, 1)
    assert.equal(t.edits[0]?.data.content, EXPIRED_TEXT)
    assert.deepEqual(t.edits[0]?.data.components, [])
    const late = fakeBtn(yesId, 'u1')
    t.events.emit('interactionCreate', late.i)
    await settle()
    assert.match(textOf(late.sent[0]), /too old/)
    assert.equal(t.downloadCalls.length, 0)
  })
})
