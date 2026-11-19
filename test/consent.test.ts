import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { consentSubject, EXPIRED_TEXT } from '../src/bot/consent.ts'
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
