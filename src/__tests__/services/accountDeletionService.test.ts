import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: {
    from: vi.fn(),
    auth: { admin: { deleteUser: vi.fn() } },
  },
}))

vi.mock('../../lib/photoStorage.js', () => ({
  removePhoto: vi.fn().mockResolvedValue(true),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { removePhoto } from '../../lib/photoStorage.js'
import { deleteAccount } from '../../services/accountDeletionService.js'

/**
 * Supprimer son compte.
 *
 * Ce qui part et ce qui reste n'est pas une décision technique : c'est ce que
 * la page `/supprimer-mes-donnees` promet publiquement. Ces tests sont la
 * traduction de cette promesse.
 */

const USER = 'habitant-1'

interface Scenario {
  memberships?: { tenant_id: string }[]
  reports?: { id: string; photo_url: string | null }[]
  deleteUserError?: { message: string } | null
}

function mockDb(scenario: Scenario = {}) {
  const calls = {
    reportsUpdate: vi.fn(),
    deleted: [] as string[],
  }

  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table === 'tenant_users') {
      return {
        select: () => ({
          eq: () => ({ limit: () => Promise.resolve({ data: scenario.memberships ?? [] }) }),
        }),
      }
    }

    if (table === 'reports') {
      return {
        select: () => ({ eq: () => Promise.resolve({ data: scenario.reports ?? [] }) }),
        update: (values: unknown) => {
          calls.reportsUpdate(values)
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    }

    return {
      delete: () => ({
        eq: () => {
          calls.deleted.push(table)
          return Promise.resolve({ error: null })
        },
      }),
    }
  }) as never)

  vi.mocked(supabaseAdmin.auth.admin.deleteUser).mockResolvedValue({
    data: {} as never,
    error: (scenario.deleteUserError ?? null) as never,
  })

  return calls
}

beforeEach(() => vi.clearAllMocks())

describe('what deletion removes', () => {
  it('erases the photos of the reports that were theirs', async () => {
    mockDb({
      reports: [
        { id: 'r1', photo_url: 'https://photos/1.jpg' },
        { id: 'r2', photo_url: 'https://photos/2.jpg' },
      ],
    })

    const outcome = await deleteAccount(USER)

    expect(removePhoto).toHaveBeenCalledTimes(2)
    expect(outcome.photosRemoved).toBe(2)
  })

  /** Un fil de conversation dépersonnalisé reste une conversation. */
  it('deletes the messages exchanged with the agents', async () => {
    const calls = mockDb()

    await deleteAccount(USER)

    expect(calls.deleted).toContain('report_comments')
  })

  it('removes what only served to reach them', async () => {
    const calls = mockDb()

    await deleteAccount(USER)

    expect(calls.deleted).toContain('device_tokens')
    expect(calls.deleted).toContain('notification_preferences')
  })

  it('deletes the account itself', async () => {
    mockDb()

    await deleteAccount(USER)

    expect(supabaseAdmin.auth.admin.deleteUser).toHaveBeenCalledWith(USER)
  })
})

describe('what deletion keeps', () => {
  /**
   * Le signalement reste : la commune doit savoir qu'un lampadaire a été
   * réparé, et son obligation de traiter ne disparaît pas avec un compte.
   */
  it('keeps the reports, stripped of the person', async () => {
    const calls = mockDb({ reports: [{ id: 'r1', photo_url: null }] })

    const outcome = await deleteAccount(USER)

    expect(calls.reportsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: null, photo_url: null, anonymous_email: null })
    )
    expect(outcome.reportsAnonymised).toBe(1)
  })

  /** Le jeton de suivi est une preuve d'identité : elle n'a plus de titulaire. */
  it('clears the follow-up token rather than leaving it behind', async () => {
    const calls = mockDb({ reports: [{ id: 'r1', photo_url: null }] })

    await deleteAccount(USER)

    expect(calls.reportsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ anonymous_token: null })
    )
  })
})

describe('who may not delete themselves this way', () => {
  /**
   * Un agent municipal porte un rôle dans une commune, et les journaux
   * d'audit existent pour qu'on puisse vérifier qui a fait quoi. Sa révocation
   * est une décision de la collectivité.
   */
  it('refuses a member of a commune team', async () => {
    const calls = mockDb({ memberships: [{ tenant_id: 'tenant-1' }] })

    await expect(deleteAccount(USER)).rejects.toMatchObject({ status: 409, code: 'team_member' })
    expect(supabaseAdmin.auth.admin.deleteUser).not.toHaveBeenCalled()
    expect(calls.reportsUpdate).not.toHaveBeenCalled()
  })
})

describe('when the account itself cannot be removed', () => {
  /**
   * Un compte vide est gênant et réparable ; des photos restées en ligne après
   * une suppression annoncée ne le seraient pas. D'où l'ordre, et d'où le
   * message qui dit exactement ce qui s'est passé.
   */
  it('says the data is gone but the account is not', async () => {
    mockDb({
      reports: [{ id: 'r1', photo_url: 'https://photos/1.jpg' }],
      deleteUserError: { message: 'nope' },
    })

    await expect(deleteAccount(USER)).rejects.toMatchObject({ status: 500 })
    expect(removePhoto).toHaveBeenCalled()
  })
})
