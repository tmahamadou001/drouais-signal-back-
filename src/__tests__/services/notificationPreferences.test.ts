import { createHmac } from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import {
  allowsEmail,
  allowsPush,
  unsubscribeToken,
  emailFromUnsubscribeToken,
  unsubscribeUrl,
} from '../../services/notificationPreferences.js'

/**
 * `notification_preferences` et `email_optouts`, simulées ensemble.
 *
 * `preferences` à `null` signifie « aucune ligne » — le cas d'un citoyen qui
 * n'a jamais ouvert l'écran, et qui doit tout recevoir.
 */
function mockTables(options: {
  preferences?: Record<string, boolean> | null
  optedOut?: boolean
}) {
  const preferencesRow = {
    maybeSingle: vi.fn().mockResolvedValue({ data: options.preferences ?? null, error: null }),
  }
  const optoutRow = {
    maybeSingle: vi.fn().mockResolvedValue({
      data: options.optedOut ? { email: 'jean@exemple.fr' } : null,
      error: null,
    }),
  }

  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => ({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue(table === 'email_optouts' ? optoutRow : preferencesRow),
    }),
  })) as never)
}

describe('allowsEmail', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allows everything when the citizen never touched the screen', async () => {
    mockTables({ preferences: null })

    expect(await allowsEmail({ userId: 'user-1', email: 'jean@exemple.fr' }, 'status')).toBe(true)
  })

  it('honours the switch for that one event, leaving the other alone', async () => {
    mockTables({ preferences: { email_status: false, email_comment: true } })

    expect(await allowsEmail({ userId: 'user-1', email: 'jean@exemple.fr' }, 'status')).toBe(false)
    expect(await allowsEmail({ userId: 'user-1', email: 'jean@exemple.fr' }, 'comment')).toBe(true)
  })

  it('lets an unsubscribe override the grid', async () => {
    mockTables({ preferences: { email_status: true }, optedOut: true })

    expect(await allowsEmail({ userId: 'user-1', email: 'jean@exemple.fr' }, 'status')).toBe(false)
  })

  it('still silences an anonymous reporter, who has no account to hold a preference', async () => {
    mockTables({ optedOut: true })

    expect(await allowsEmail({ userId: null, email: 'jean@exemple.fr' }, 'status')).toBe(false)
  })

  it('writes to an anonymous reporter who never unsubscribed', async () => {
    mockTables({ optedOut: false })

    expect(await allowsEmail({ userId: null, email: 'jean@exemple.fr' }, 'status')).toBe(true)
  })

  it('does not silence push when e-mail is switched off', async () => {
    mockTables({ preferences: { email_status: false, push_status: true } })

    expect(await allowsPush('user-1', 'status')).toBe(true)
  })
})

describe('unsubscribe token', () => {
  it('round-trips the address', () => {
    expect(emailFromUnsubscribeToken(unsubscribeToken('Jean@Exemple.FR'))).toBe('jean@exemple.fr')
  })

  it('rejects a tampered signature', () => {
    const token = unsubscribeToken('jean@exemple.fr')
    const [payload] = token.split('.')

    expect(emailFromUnsubscribeToken(`${payload}.forged`)).toBeNull()
  })

  it('rejects a swapped payload — the signature covers the address', () => {
    const [, signature] = unsubscribeToken('jean@exemple.fr').split('.')
    const other = Buffer.from('victime@exemple.fr').toString('base64url')

    expect(emailFromUnsubscribeToken(`${other}.${signature}`)).toBeNull()
  })

  it('rejects a token with no separator', () => {
    expect(emailFromUnsubscribeToken('nimportequoi')).toBeNull()
  })

  it('keeps the address out of the query string', () => {
    // Une URL traverse les journaux, les référents et l'historique : l'adresse
    // voyage dans le jeton signé, jamais en clair à côté.
    expect(unsubscribeUrl('jean@exemple.fr')).not.toContain('jean@exemple.fr')
  })
})

/**
 * Un lien de désabonnement a une durée de vie.
 *
 * Il n'en avait pas : un e-mail archivé restait indéfiniment un bouton « faire
 * taire cette adresse » pour qui le retrouvait.
 */
describe('how long an unsubscribe link lasts', () => {
  const EMAIL = 'habitant@exemple.fr'
  const JOUR = 86_400_000

  it('accepts a fresh token', () => {
    expect(emailFromUnsubscribeToken(unsubscribeToken(EMAIL))).toBe(EMAIL)
  })

  it('accepts one issued within the window', () => {
    const token = unsubscribeToken(EMAIL, Date.now() - 80 * JOUR)

    expect(emailFromUnsubscribeToken(token)).toBe(EMAIL)
  })

  it('refuses one issued too long ago', () => {
    const token = unsubscribeToken(EMAIL, Date.now() - 100 * JOUR)

    expect(emailFromUnsubscribeToken(token)).toBeNull()
  })

  /** L'horodatage est dans la signature : on ne peut pas le rajeunir. */
  it('cannot be back-dated without breaking the signature', () => {
    const token = unsubscribeToken(EMAIL, Date.now() - 100 * JOUR)
    const [, signature] = token.split('.')
    const forged = Buffer.from(`${EMAIL}|${Date.now()}`).toString('base64url')

    expect(emailFromUnsubscribeToken(`${forged}.${signature}`)).toBeNull()
  })

  /**
   * Les jetons déjà partis ne portent pas d'horodatage. Les refuser casserait
   * le désabonnement depuis tous les e-mails en circulation — le geste qu'on
   * ne doit jamais rendre difficile.
   */
  it('still accepts the tokens already out there, which carry no date', () => {
    const legacy = Buffer.from(EMAIL).toString('base64url')
    const signature = createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-unsubscribe-secret')
      .update(legacy)
      .digest('base64url')

    expect(emailFromUnsubscribeToken(`${legacy}.${signature}`)).toBe(EMAIL)
  })
})
