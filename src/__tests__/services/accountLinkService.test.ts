import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { auth: { admin: { generateLink: vi.fn() } } },
}))

const verifyOtp = vi.fn()
vi.mock('../../lib/supabaseAuthClient.js', () => ({
  createCredentialsClient: () => ({ auth: { verifyOtp } }),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { buildAccountLink, redeemAccountLink } from '../../services/accountLinkService.js'

/**
 * Le lien reçu par un agent qu'on invite.
 *
 * Deux choses à tenir, et elles ont toutes deux cassé en production :
 *
 *  - il pointe sur **notre** domaine, pas sur celui de Supabase ;
 *  - il pointe sur le **sous-domaine de la commune**, parce que l'apex sert
 *    désormais le site de présentation et n'a pas de page `/set-password`.
 */

const GENERATED = {
  data: {
    user: { id: 'user-1' },
    properties: {
      action_link: 'https://projet.supabase.co/auth/v1/verify?token=raw&type=invite',
      hashed_token: 'abcdef0123456789abcdef',
    },
  },
  error: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CLIENT_URL = 'https://onsignale.fr'
  vi.mocked(supabaseAdmin.auth.admin.generateLink).mockResolvedValue(GENERATED as never)
})

describe('building the link', () => {
  it('never hands out the Supabase URL', async () => {
    const link = await buildAccountLink({ type: 'invite', email: 'a@ville.fr', tenantSlug: 'dreux' })

    expect(link?.url).not.toContain('supabase')
    expect(link?.url).not.toContain('/auth/v1/verify')
  })

  /**
   * Le défaut qui a cassé l'invitation : l'apex sert le site de présentation
   * depuis Cloudflare, et `/set-password` n'y existe pas. L'invité arrivait
   * sur une page introuvable, sans rien pour comprendre.
   */
  it('points at the commune subdomain, not the apex', async () => {
    const link = await buildAccountLink({ type: 'invite', email: 'a@ville.fr', tenantSlug: 'dreux' })

    expect(link?.url).toBe(
      'https://dreux.onsignale.fr/set-password?token=abcdef0123456789abcdef&type=invite'
    )
  })

  it('carries the kind of link, so the page knows what it redeems', async () => {
    const link = await buildAccountLink({ type: 'recovery', email: 'a@ville.fr', tenantSlug: 'la-loupe' })

    expect(link?.url).toContain('type=recovery')
    expect(link?.url).toContain('https://la-loupe.onsignale.fr/')
  })

  /** Sans commune — mot de passe oublié depuis l'apex — on reste sur la base. */
  it('falls back to the base URL when no commune is known', async () => {
    const link = await buildAccountLink({ type: 'recovery', email: 'a@ville.fr', tenantSlug: null })

    expect(link?.url).toBe(
      'https://onsignale.fr/set-password?token=abcdef0123456789abcdef&type=recovery'
    )
  })

  it('hands back the account it belongs to', async () => {
    const link = await buildAccountLink({ type: 'invite', email: 'a@ville.fr', tenantSlug: 'dreux' })

    expect(link?.userId).toBe('user-1')
  })

  /** Adresse déjà inscrite, projet indisponible : l'appelant décide quoi en faire. */
  it('returns nothing when Supabase issues no token', async () => {
    vi.mocked(supabaseAdmin.auth.admin.generateLink).mockResolvedValue({
      data: { user: null, properties: null },
      error: { code: 'email_exists' },
    } as never)

    expect(await buildAccountLink({ type: 'invite', email: 'a@ville.fr', tenantSlug: 'dreux' })).toBeNull()
  })
})

describe('redeeming the token', () => {
  it('exchanges it for a session', async () => {
    verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'jwt-123' }, user: { id: 'user-1', email: 'a@ville.fr' } },
      error: null,
    })

    const session = await redeemAccountLink({ token: 'abc', type: 'invite' })

    expect(session).toEqual({ accessToken: 'jwt-123', userId: 'user-1', email: 'a@ville.fr' })
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc', type: 'invite' })
  })

  /**
   * Jamais sur `supabaseAdmin` : `verifyOtp` ouvre une session, et
   * `supabase-js` choisit l'en-tête `Authorization` de chaque requête à partir
   * de la session du client. Le contournement du RLS disparaîtrait pour le
   * processus entier.
   */
  it('uses a disposable client, never the shared admin one', async () => {
    verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'jwt' }, user: { id: 'u', email: null } },
      error: null,
    })

    await redeemAccountLink({ token: 'abc', type: 'recovery' })

    expect(supabaseAdmin).not.toHaveProperty('auth.verifyOtp')
  })

  /** Expiré, déjà utilisé, inventé : la même réponse, pour ne rien renseigner. */
  it('refuses a token it cannot verify', async () => {
    verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'expired' } })

    await expect(redeemAccountLink({ token: 'abc', type: 'invite' })).rejects.toMatchObject({
      status: 401,
      code: 'invalid_link',
    })
  })

  it('refuses a verification that returns no session', async () => {
    verifyOtp.mockResolvedValue({ data: { session: null, user: { id: 'u' } }, error: null })

    await expect(redeemAccountLink({ token: 'abc', type: 'invite' })).rejects.toMatchObject({
      status: 401,
    })
  })
})
