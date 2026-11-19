// Bounds on what reading one attachment may cost: time, memory and the
// length of the text that goes to the provider.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { extractPdfText, processImage } from '../src/bot/attachments.ts'
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

  it('streams over the size cap count against the total, so many of them stop early', () => {
    const big = deflateSync(Buffer.alloc(5 * 1024 * 1024, 0x20))
    const ms = elapsed(() => extractPdfText(pdfWith(...Array.from({ length: 2000 }, () => big))))
    assert.ok(ms < 200, `took ${Math.round(ms)} ms`)
  })

  it('long open strings and arrays stay within a small heap', () => {
    // A child process with a 96 MB heap: building strings or arrays from such
    // streams one piece per byte runs out of it.
    const script = `
      import { deflateSync } from 'node:zlib'
      const { extractPdfText } = await import(${JSON.stringify(new URL('../src/bot/file-text.ts', import.meta.url).href)})
      const open = deflateSync(Buffer.alloc(4 * 1024 * 1024 - 64, '('))
      const unclosed = deflateSync(Buffer.from('(' + 'a\\\\'.repeat(1_000_000)))
      const items = deflateSync(Buffer.from('[' + '()'.repeat(2_000_000)))
      const parts = [open, unclosed, items, open, unclosed, items, open, items]
      const pdf = Buffer.concat(parts.flatMap((p) => [Buffer.from('stream\\n'), p, Buffer.from('\\nendstream\\n')]))
      extractPdfText(pdf)
      console.log('ok')
    `
    const out = execFileSync(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', script], { encoding: 'utf8' })
    assert.equal(out.trim(), 'ok')
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

/** A PNG chunk: length, type, data and CRC. */
const chunk = (type: string, data: Buffer) => {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([len, typed, crc])
}

/** A few hundred bytes that declare a width x height RGB PNG. */
const pngDeclaring = (width: number, height: number) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(width * 3 + 1))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('image processing: bounds', () => {
  it('refuses an image declaring 16000 x 16000 pixels before decoding it', async () => {
    await assert.rejects(processImage(pngDeclaring(16_000, 16_000), 'image/png'), /pixel limit/)
  })
})
