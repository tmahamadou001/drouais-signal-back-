/**
 * The OnSignale mark, for e-mail.
 *
 * Served as a PNG from the public front rather than embedded. The three
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
 */
const PUBLIC_URL = process.env.CLIENT_URL || 'https://onsignale.fr'

/** 192 px source, displayed smaller so it stays sharp on a retina screen. */
export const LOGO_URL = `${PUBLIC_URL}/icons/icon-192.png`

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
