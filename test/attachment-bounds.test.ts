// Bounds on what reading one attachment may cost: time, memory and the
// length of the text that goes to the provider.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deflateSync } from 'node:zlib'
import { extractPdfText } from '../src/bot/attachments.ts'
import { MAX_TEXT_CHARS, TRUNCATED } from '../src/bot/attachments.ts'

const pdfWith = (...streams: Buffer[]) =>
  Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    ...streams.flatMap((s) => [Buffer.from('1 0 obj\n<< /Filter /FlateDecode >>\nstream\n'), s, Buffer.from('\nendstream\nendobj\n')]),
    Buffer.from('%%EOF'),
  ])

const elapsed = (fn: () => void) => {
  const start = performance.now()
  fn()
  return performance.now() - start
}

describe('PDF text extraction: bounds', () => {
  it('many stream openers without an end take linear time', () => {
    const ms = elapsed(() => extractPdfText(Buffer.from('stream\n'.repeat(200_000))))
    assert.ok(ms < 500, `took ${Math.round(ms)} ms`)
  })

  it('many open strings before Tj take linear time', () => {
    const body = Buffer.from(`${'('.repeat(100_000)}x) Tj ${'(a\\'.repeat(50_000)}`)
    const ms = elapsed(() => extractPdfText(pdfWith(deflateSync(body))))
    assert.ok(ms < 500, `took ${Math.round(ms)} ms`)
  })

  it('a stream that inflates to 64 MiB is skipped, not inflated in full', () => {
    const bomb = deflateSync(Buffer.from('(Bomb) Tj '.repeat(6_710_886)))
    let text = ''
    const ms = elapsed(() => {
      text = extractPdfText(pdfWith(bomb, deflateSync(Buffer.from('BT (After the big one) Tj ET'))))
    })
    assert.ok(ms < 500, `took ${Math.round(ms)} ms`)
    assert.match(text, /After the big one/)
    assert.doesNotMatch(text, /Bomb/)
  })

  it('cuts the text to the text-file limit, with the same marker', () => {
    const line = Buffer.from(`BT ${'(Lorem ipsum dolor sit amet) Tj '.repeat(20_000)}ET`)
    const text = extractPdfText(pdfWith(deflateSync(line)))
    assert.ok(text.length <= MAX_TEXT_CHARS + TRUNCATED.length, `length ${text.length}`)
    assert.ok(text.endsWith(TRUNCATED))
  })

  it('still reads strings and TJ arrays, with escapes', () => {
    const body = Buffer.from('BT (Total \\(net\\)) Tj [(Item) -250 (one)] TJ ET')
    assert.equal(extractPdfText(pdfWith(deflateSync(body))), 'Total (net) Item one')
  })
})
