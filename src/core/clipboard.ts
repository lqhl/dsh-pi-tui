/**
 * OSC 52 clipboard helpers. Pure and unit-testable: extract and decode the
 * text payload from an OSC 52 escape sequence so the terminal wrapper can
 * mirror it into the tmux paste buffer and the local OS clipboard (the same
 * three-route copy grok uses, instead of relying on the terminal alone), and
 * encode UI-side copy commands into the same sequence.
 */

const ESC = '\x1b'
const BEL = '\x07'

/** OSC 52: ESC ] 52 ; <selection> ; <base64> BEL. Built from strings so the
 * control characters don't trip the no-control-regex lint rule. */
const OSC52_PATTERN = new RegExp(`${ESC}]52;[^;${ESC}${BEL}]*;([A-Za-z0-9+/=]*)${BEL}`, 'g')

/**
 * Encode `text` as an OSC 52 clipboard write (`c` = clipboards). Writing the
 * sequence through the terminal lets ClipboardTerminal mirror it into tmux +
 * the OS clipboard, and terminals that natively handle OSC 52 act directly.
 */
export function osc52Encode(text: string): string {
  return `${ESC}]52;c;${Buffer.from(text, 'utf8').toString('base64')}${BEL}`
}

/**
 * Decode every OSC 52 payload in `data` to UTF-8 text. Malformed payloads are
 * skipped (best effort). Returns an empty array when `data` carries no OSC 52.
 */
export function decodeOsc52(data: string): string[] {
  if (!data.includes('\x1b]52;')) return []
  const texts: string[] = []
  for (const match of data.matchAll(OSC52_PATTERN)) {
    const payload = match[1]
    if (payload === undefined || payload === '') continue
    const text = Buffer.from(payload, 'base64').toString('utf8')
    if (text !== '') texts.push(text)
  }
  return texts
}
