import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getAuthUserEmail } = vi.hoisted(() => ({ getAuthUserEmail: vi.fn() }))
vi.mock('../../lib/authHelpers.js', () => ({ getAuthUserEmail }))

import { resolveCitizenContact } from '../../lib/citizenContact.js'

beforeEach(() => {
  getAuthUserEmail.mockReset()
})

describe('resolveCitizenContact', () => {
  it('prefers the account address, which is verified and current', async () => {
    getAuthUserEmail.mockResolvedValue('habitant@exemple.fr')

    expect(await resolveCitizenContact({ user_id: 'u1', anonymous_email: 'autre@exemple.fr' })).toEqual({
      channel: 'account',
      reachable: true,
      email: 'habitant@exemple.fr',
    })
  })

  /**
   * The bug this file exists for: the address was on the same row all along,
   * and only the status notification ever read it.
   */
  it('falls back to the address left when filing without an account', async () => {
    expect(await resolveCitizenContact({ user_id: null, anonymous_email: 'passant@exemple.fr' })).toEqual({
      channel: 'email',
      reachable: true,
      email: 'passant@exemple.fr',
    })
  })

  it('trims the address before deciding there is one', async () => {
    expect(await resolveCitizenContact({ user_id: null, anonymous_email: '   ' })).toEqual({
      channel: 'none',
      reachable: false,
      email: null,
    })
  })

  /**
   * Filing without signing up is the point of the product, so this case is
   * ordinary rather than exceptional — and has to be said out loud.
   */
  it('says plainly when nobody can be reached', async () => {
    expect(await resolveCitizenContact({ user_id: null, anonymous_email: null })).toEqual({
      channel: 'none',
      reachable: false,
      email: null,
    })
    expect(await resolveCitizenContact({ user_id: null })).toEqual({
      channel: 'none',
      reachable: false,
      email: null,
    })
  })

  it('does not claim an account is reachable when its address cannot be read', async () => {
    getAuthUserEmail.mockResolvedValue(null)

    expect(await resolveCitizenContact({ user_id: 'u1' })).toEqual({
      channel: 'none',
      reachable: false,
      email: null,
    })
  })

  it('never looks up an account that does not exist', async () => {
    await resolveCitizenContact({ user_id: null, anonymous_email: 'passant@exemple.fr' })

    expect(getAuthUserEmail).not.toHaveBeenCalled()
  })
})
