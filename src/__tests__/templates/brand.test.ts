import { describe, it, expect } from 'vitest'
import { plainSubject, LOGO_URL, logoImg, EMAIL_COLORS } from '../../templates/brand.js'

describe('plainSubject', () => {
  /**
   * An emoji in a subject renders differently on every platform and is what
   * several corporate filters score as promotional — on operational mail sent
   * to a municipal service, exactly what must not happen.
   */
  it('removes the category icon from a subject', () => {
    expect(plainSubject('[🛣️ Voirie] Nouveau signalement — Nid de poule'))
      .toBe('[Voirie] Nouveau signalement — Nid de poule')
  })

  it('leaves accents, dashes and quotes alone', () => {
    const subject = 'Votre signalement "Trottoir déformé" a été résolu — OnSignale'
    expect(plainSubject(subject)).toBe(subject)
  })

  /** A commune name or a report title can carry one too. */
  it('cleans an emoji that came from user content', () => {
    expect(plainSubject('Résumé hebdomadaire 🏛️ Dreux')).toBe('Résumé hebdomadaire Dreux')
  })

  it('collapses the gap the removal leaves behind', () => {
    expect(plainSubject('Nouveau ✅ message')).toBe('Nouveau message')
  })
})

describe('the mark', () => {
  /**
   * `CLIENT_URL` is `http://localhost:5173` in development — an address no
   * mail client can reach, which is why the logo was missing from every mail
   * sent from a developer machine. A mail is read from somewhere else than the
   * session that sent it, so its assets need a public address by construction.
   */
  it('is served from a public origin, never from the dev front', () => {
    expect(LOGO_URL).toMatch(/^https:\/\//)
    expect(LOGO_URL).not.toContain('localhost')
  })

  /**
   * Outlook ignores the style, everything else ignores the attributes, and a
   * logo with neither loads at its natural 192 px and blows the header apart.
   */
  it('carries its size as attributes and as style', () => {
    const html = logoImg(32)
    expect(html).toContain('width="32"')
    expect(html).toContain('height="32"')
    expect(html).toContain('width:32px;height:32px')
  })

  /** A blocked image must never leave a mail unsigned. */
  it('keeps an alt text', () => {
    expect(logoImg()).toContain('alt="OnSignale"')
  })
})

describe('the palette', () => {
  /** The same tokens as the app: two mails side by side must look related. */
  it('matches the brand colour used by the interface', () => {
    expect(EMAIL_COLORS.brand700).toBe('#1A56A0')
    expect(EMAIL_COLORS.ink).toBe('#111827')
    expect(EMAIL_COLORS.muted).toBe('#6B7280')
  })
})
