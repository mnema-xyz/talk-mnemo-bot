// Text from a file for the provider: the length cap, and the text of a PDF's
// content streams. Every step here is linear in the file and bounded in
// memory, whatever the file contains.
import { inflateSync } from 'node:zlib'

/** Text from a file is cut to this many characters. */
export const MAX_TEXT_CHARS = 40_000
/** What follows text that was cut. */
export const TRUNCATED = '\n\n[... content truncated ...]'

/** One stream inflates to at most this many bytes; a larger one is skipped. */
const MAX_STREAM_BYTES = 4 * 1024 * 1024
/** All streams of one PDF inflate to at most this many bytes together; a
 * skipped stream counts with the bytes it was inflated to. */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024
/** Strings kept from one `[...]` array. */
const MAX_ARRAY_ITEMS = 10_000

/** The text, cut to MAX_TEXT_CHARS with the marker when it is longer. */
export function cutText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}${TRUNCATED}` : text
}

/** The text shown by the Tj and TJ operators of a PDF's content streams,
 * cut like a text file. Not a PDF parser: enough for plain text PDFs. */
export function extractPdfText(buf: Buffer): string {
  const out = new TextSink()
  let budget = MAX_INFLATED_BYTES
  for (const raw of pdfStreams(buf.toString('latin1'))) {
    if (out.full || budget <= 0) break
    const max = Math.min(MAX_STREAM_BYTES, budget)
    const decoded = inflated(raw, max)
    // A skipped stream was inflated up to max before it was given up.
    budget -= decoded?.length ?? max
    if (decoded === undefined) continue
    shownStrings(decoded, out)
  }
  return cutText(out.text())
}

/** The bodies between `stream` and `endstream`, found with indexOf only. */
function* pdfStreams(pdf: string): Generator<string> {
  let pos = 0
  for (;;) {
    const at = pdf.indexOf('stream', pos)
    if (at < 0) return
    let start = at + 'stream'.length
    if (pdf[start] === '\r') start++
    if (pdf[start] !== '\n') {
      pos = at + 1
      continue
    }
    start++
    const end = pdf.indexOf('\nendstream', start)
    // No end after this opener means none after any later one either.
    if (end < 0) return
    const body = pdf.slice(start, end)
    yield body.endsWith('\r') ? body.slice(0, -1) : body
    pos = end + '\nendstream'.length
  }
}

/** The stream inflated, the raw bytes when it is not deflated, undefined
 * when it inflates to more than max bytes. */
function inflated(raw: string, max: number): string | undefined {
  const bytes = Buffer.from(raw, 'latin1')
  try {
    return inflateSync(bytes, { maxOutputLength: max }).toString('latin1')
  } catch (err) {
    if (err instanceof RangeError) return undefined
    return bytes.length <= max ? raw : undefined
  }
}

/** Collects text pieces up to just past MAX_TEXT_CHARS. */
class TextSink {
  private readonly parts: string[] = []
  private length = 0

  get full(): boolean {
    return this.length > MAX_TEXT_CHARS
  }

  add(piece: string): void {
    const clean = piece.replace(/\s+/g, ' ').trim()
    if (!clean || this.full) return
    this.parts.push(clean)
    this.length += clean.length + 1
  }

  text(): string {
    return this.parts.join(' ')
  }
}

/** Where the scan of a content stream is: the strings of an open `[`, and
 * the string just before, which a `Tj` shows. */
interface Scan {
  i: number
  array: string[] | undefined
  arrayChars: number
  last: string | undefined
}

/** Adds the strings shown by `(...) Tj` and `[...] TJ` in a content stream. */
function shownStrings(s: string, out: TextSink): void {
  const scan: Scan = { i: 0, array: undefined, arrayChars: 0, last: undefined }
  while (scan.i < s.length && !out.full) {
    if (!step(s, scan, out)) return
  }
}

/** One token of the scan; false when the rest cannot hold text. */
function step(s: string, scan: Scan, out: TextSink): boolean {
  const ch = s[scan.i] ?? ''
  if (ch === '(') {
    const str = literal(s, scan.i + 1)
    if (!str) return false
    if (!scan.array) scan.last = str.text
    else keep(scan, str.text)
    scan.i = str.end
  } else if (ch === '[') {
    scan.array = []
    scan.arrayChars = 0
    scan.i++
  } else if (ch === ']') {
    const items = scan.array ?? []
    scan.array = undefined
    scan.i = skipSpace(s, scan.i + 1)
    if (s.startsWith('TJ', scan.i)) for (const item of items) out.add(item)
  } else if (ch === 'T' && s[scan.i + 1] === 'j' && scan.last !== undefined) {
    out.add(scan.last)
    scan.last = undefined
    scan.i += 2
  } else {
    if (!/\s/.test(ch)) scan.last = undefined
    scan.i++
  }
  return true
}

/** Keeps a string of an open array, up to MAX_ARRAY_ITEMS strings and
 * MAX_TEXT_CHARS characters. */
function keep(scan: Scan, text: string): void {
  if (!scan.array || scan.array.length >= MAX_ARRAY_ITEMS || scan.arrayChars > MAX_TEXT_CHARS) return
  scan.array.push(text)
  scan.arrayChars += text.length
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i] ?? '')) i++
  return i
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }

/** A PDF literal string starting after its `(`: balanced parentheses and
 * backslash escapes; undefined when it is not closed. The text is built from
 * slices between escapes and keeps at most MAX_TEXT_CHARS of it. */
function literal(s: string, from: number): { text: string; end: number } | undefined {
  const text = new Pieces()
  let depth = 1
  let run = from
  for (let i = from; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') {
      text.add(s.slice(run, i))
      i = escaped(s, i + 1, text)
      run = i + 1
    } else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) {
      text.add(s.slice(run, i))
      return { text: text.join(), end: i + 1 }
    }
  }
  return undefined
}

/** Adds the escape starting at i (after the backslash); returns its last index. */
function escaped(s: string, i: number, text: Pieces): number {
  const octal = /^[0-7]{1,3}/.exec(s.slice(i, i + 3))?.[0]
  if (octal) {
    text.add(String.fromCharCode(parseInt(octal, 8)))
    return i + octal.length - 1
  }
  const next = s[i] ?? ''
  text.add(ESCAPES[next] ?? next)
  return i
}

/** Text in pieces, up to MAX_TEXT_CHARS; later pieces are dropped. */
class Pieces {
  private readonly parts: string[] = []
  private length = 0

  add(piece: string): void {
    if (!piece || this.length >= MAX_TEXT_CHARS) return
    const kept = piece.slice(0, MAX_TEXT_CHARS - this.length)
    this.parts.push(kept)
    this.length += kept.length
  }

  join(): string {
    return this.parts.join('')
  }
}
