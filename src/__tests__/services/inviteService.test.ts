import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { auth: { admin: { generateLink: vi.fn() } } },
}))
vi.mock('../../lib/authHelpers.js', () => ({ findAuthUserByEmail: vi.fn() }))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { findAuthUserByEmail } from '../../lib/authHelpers.js'
import { provisionInvite } from '../../services/inviteService.js'

/** La commune dont on rejoint l'espace : son sous-domaine porte le lien. */
const SLUG = 'dreux'

/**
 * Ce que GoTrue répond pour une adresse qu'il n'a jamais vue.
 *
 * `hashed_token` est ce qu'on garde : l'`action_link` pointe sur le projet
 * Supabase, et c'est précisément ce qui ne doit plus arriver dans la boîte
 * mail d'un agent (voir `accountLinkService`).
 */
function linkCreated() {
  return {
    data: {
      user: { id: 'new-user', email_confirmed_at: null },
      properties: {
        action_link: 'https://projet.supabase.co/auth/v1/verify?token=abc',
        hashed_token: 'abc123def456ghi789',
      },
    },
    error: null,
  }
}

/** `422 email_exists` — what GoTrue answers for any address it already knows. */
function emailExists() {
  return {
    data: { user: null, properties: null },
    error: { code: 'email_exists', message: 'A user with this email address has already been registered' },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('provisionInvite', () => {
  it('creates the account and returns a link for a new address', async () => {
    vi.mocked(supabaseAdmin.auth.admin.generateLink).mockResolvedValue(linkCreated() as never)

    const result = await provisionInvite('agent@ville.fr', SLUG)

    expect(result.userId).toBe('new-user')
    expect(result.alreadyRegistered).toBe(false)

    // Notre adresse, sur le sous-domaine de la commune — et pas celle de
    // Supabase, que l'invité ne peut ni reconnaître ni vérifier.
    expect(result.actionLink).toContain('/set-password')
    expect(result.actionLink).toContain('token=abc123def456ghi789')
    expect(result.actionLink).not.toContain('supabase')
    expect(findAuthUserByEmail).not.toHaveBeenCalled()
  })

  it('adds an address that already has an account, with no password link', async () => {
    // The case that used to answer 500: a resident who filed a report with an
    // account and is then recruited, or an agent joining a second commune.
    vi.mocked(supabaseAdmin.auth.admin.generateLink).mockResolvedValue(emailExists() as never)
    vi.mocked(findAuthUserByEmail).mockResolvedValue({ id: 'existing-user' })

    const result = await provisionInvite('habitant@ville.fr', SLUG)

    expect(result).toEqual({
      userId: 'existing-user',
      actionLink: null,
      alreadyRegistered: true,
    })
  })

  it('still fails when the link could not be generated for any other reason', async () => {
    vi.mocked(supabaseAdmin.auth.admin.generateLink).mockResolvedValue({
      data: { user: null, properties: null },
      error: { code: 'unexpected_failure', message: 'boom' },
    } as never)
    vi.mocked(findAuthUserByEmail).mockResolvedValue(null)

    await expect(provisionInvite('agent@ville.fr', SLUG)).rejects.toMatchObject({
      status: 500,
      code: 'internal_error',
    })
  })
})
