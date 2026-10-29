/**
 * The OnSignale mark and palette, for e-mail.
 *
 * ── The mark ───────────────────────────────────────────────────────────────
 *
 * Served as a PNG from a public host rather than embedded. The three
 * alternatives all fail somewhere that matters:
 *
 *  - an inline `<svg>` is stripped outright by Gmail and Outlook;
 *  - a `data:` URI is blocked by Gmail and most corporate filters;
 *  - a `cid:` attachment renders unevenly and adds weight to every send.
 *
 * A hosted URL is the only one every client agrees on. It costs a request the
 * recipient may refuse — which is why every header that uses this keeps the
 * word "OnSignale" in text beside it, so a blocked image never leaves a mail
 * unsigned.
 *
 * ── The palette ────────────────────────────────────────────────────────────
 *
 * The same tokens as `client/tailwind.config.ts`. They were not: each template
 * had grown its own greys — slate in one, neutral in another — so two mails
 * from the same platform, opened side by side, did not look like they came
 * from the same place. Mail cannot read CSS variables, so the values are
 * copied here; this is the one copy.
 */

/**
 * Where the mark is fetched from.
 *
 * **Not** `CLIENT_URL`: in development it is `http://localhost:5173`, an
 * address no mail client can ever reach — which is exactly why the logo was
 * missing from every mail sent from a developer machine, and would have been
 * missing from any deployment whose front lives on a preview URL. An e-mail
 * outlives the session that sent it and is read from somewhere else entirely,
 * so its assets need an address that is public by construction.
 */
const ASSET_ORIGIN = process.env.EMAIL_ASSET_URL || 'https://onsignale.fr'

/** 192 px source, displayed smaller so it stays sharp on a retina screen. */
export const LOGO_URL = `${ASSET_ORIGIN}/icons/icon-192.png`

/**
 * An `<img>` for the mark, at `size` CSS pixels.
 *
 * Width and height are set as attributes *and* in the style: Outlook ignores
 * the style, everything else ignores the attributes, and a logo with neither
 * loads at its natural 192 px and blows the header apart.
 */
export function logoImg(size = 32, radius = 8): string {
  return (
    `<img src="${LOGO_URL}" alt="OnSignale" width="${size}" height="${size}" ` +
    `style="width:${size}px;height:${size}px;border-radius:${radius}px;display:block;border:0;" />`
  )
}

/** The design tokens, as literal hex — mail has no variables. */
export const EMAIL_COLORS = {
  brand50:  '#F1F6FC',
  brand100: '#D6E4F5',
  brand700: '#1A56A0',
  brand800: '#14406F',
  brand900: '#0F2B4A',

  canvas:   '#F6F7F9',
  line:     '#E2E5EA',
  white:    '#FFFFFF',

  ink:      '#111827',
  muted:    '#6B7280',
  faint:    '#9CA3AF',

  pendingBg:  '#F1F1F2',
  pendingFg:  '#525252',
  progressBg: '#FEF6E7',
  progressFg: '#8A5A08',
  progressDot:'#EF9F27',
  doneBg:     '#E8F7F1',
  doneFg:     '#0F6B4E',
  success:    '#1D9E75',
  danger:     '#DC2626',
  dangerBg:   '#FBEAEA',
} as const

/**
 * Strips emoji from a line of text.
 *
 * Used on mail subjects. An emoji in a subject renders differently on every
 * platform, is what several corporate filters score as promotional, and reads
 * as marketing in an inbox where this platform's messages are operational —
 * a service being told a report is waiting for it, a resident being told their
 * street has been fixed. The category icon still exists in the database and
 * still serves the screens; it just does not travel in a subject line.
 */
export function plainSubject(subject: string): string {
  return subject
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\[\s+/g, '[')
    .trim()
}
