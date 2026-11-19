// What Mnemo keeps of an attachment after answering: only the bare question,
// so later questions in the thread and Regenerate never send the file again.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { customId } from '../src/bot/delivery.ts'
import { fakeBtn, fileMention, makeStream, setupBot, textOf, yesOf, type Sent } from './attachment-bot.ts'

const SECRET = 'SECRET123'

const secretFile = () =>
  Promise.resolve({ contentType: 'text/plain', size: 30, filename: 'notes.txt', stream: makeStream([Buffer.from(`the code is ${SECRET}`)]) })

const regenOf = (s: Sent | undefined) =>
  (s?.components ?? []).flatMap((row) => row.components).map((c) => c.custom_id ?? c.customId ?? '').find((id) => id.includes(':regen:'))

/** A thread started by a file question that was answered with consent. */
async function answeredFileQuestion() {
  const t = setupBot({ replyInThread: true }, { download: secretFile }, [{ text: 'Noted.' }])
  await t.emitMessage(fileMention(1))
  await t.run(fakeBtn(yesOf(t.posted[0]), 'u1').i)
  assert.equal(t.provider.requests.length, 1)
  assert.ok(JSON.stringify(t.provider.requests[0]).includes(SECRET), 'the consented question sends the file')
  return t
}

const thread = (n: number, text: string) => ({ id: `t${n}`, parent_id: 'm1', channel_id: 'c1', user_id: 'u2', username: 'u2', mentions: [], content: text, attachments: [] })

describe('attachments are not kept after the answer', () => {
  it('a later question in the thread does not send the file again', async () => {
    const t = await answeredFileQuestion()
    await t.emitMessage(thread(2, 'and what else?'))
    assert.equal(t.provider.requests.length, 2)
    const second = JSON.stringify(t.provider.requests[1])
    assert.ok(!second.includes(SECRET), second)
    assert.match(second, /read this/, 'the bare question stays in the thread')
  })

  it('the answer about a file has no Regenerate button', async () => {
    const t = await answeredFileQuestion()
    const answer = t.posted.at(-1)
    assert.equal(textOf(answer), 'Noted.')
    assert.equal(regenOf(answer), undefined)
  })

  it('a Regenerate on the answer about a file is refused and sends nothing', async () => {
    const t = await answeredFileQuestion()
    const last = (t.bot as unknown as { answers: { lastIn(c: string): { id: string } | undefined } }).answers.lastIn('c1')
    assert.ok(last)
    const click = fakeBtn(customId('regen', last.id), 'admin')
    await t.run(click.i)
    assert.equal(t.provider.requests.length, 1)
    assert.match(textOf(click.sent[0]), /do not keep attached files/)
    assert.equal(click.sent[0]?.ephemeral, true)
  })

  it('a Regenerate later in the thread does not send the file again', async () => {
    const t = await answeredFileQuestion()
    await t.emitMessage(thread(2, 'and what else?'))
    const regen = regenOf(t.posted.at(-1))
    assert.ok(regen)
    await t.run(fakeBtn(regen, 'admin').i)
    assert.equal(t.provider.requests.length, 3)
    assert.ok(!JSON.stringify(t.provider.requests[2]).includes(SECRET))
  })
})
