import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { auth: { admin: { generateLink: vi.fn() } } },
}))
vi.mock('../../lib/authHelpers.js', () => ({ findAuthUserByEmail: vi.fn() }))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { findAuthUserByEmail } from '../../lib/authHelpers.js'
import { provisionInvite } from '../../services/inviteService.js'

const REDIRECT = 'https://onsignale.fr/set-password'

/** What GoTrue answers for an address it has never seen. */
function linkCreated() {
  return {
    data: {
      user: { id: 'new-user', email_confirmed_at: null },
      properties: { action_link: 'https://auth/verify?token=abc' },
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

    const result = await provisionInvite('agent@ville.fr', REDIRECT)

    expect(result).toEqual({
      userId: 'new-user',
      actionLink: 'https://auth/verify?token=abc',
      alreadyRegistered: false,
    })
    expect(findAuthUserByEmail).not.toHaveBeenCalled()
  })

  it('adds an address that already has an account, with no password link', async () => {
    // The case that used to answer 500: a resident who filed a report with an
    // account and is then recruited, or an agent joining a second commune.
    vi.mocked(supabaseAdmin.auth.admin.generateLink).mockResolvedValue(emailExists() as never)
    vi.mocked(findAuthUserByEmail).mockResolvedValue({ id: 'existing-user' })

    const result = await provisionInvite('habitant@ville.fr', REDIRECT)

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

    await expect(provisionInvite('agent@ville.fr', REDIRECT)).rejects.toMatchObject({
      status: 500,
      code: 'internal_error',
    })
  })
})
