import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

// `vi.hoisted` : `vi.mock` est remonté au-dessus des déclarations, et une
// `const` ordinaire ne serait pas encore initialisée quand la fabrique court.
const { send } = vi.hoisted(() => ({ send: vi.fn() }))

vi.mock('resend', () => ({
  Resend: class {
    emails = { send }
  },
}))

vi.mock('../../services/auditService.js', () => ({
  auditCommuneLaunched: vi.fn().mockResolvedValue(undefined),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import {
  notifyCommuneWaitlist,
  publishTenantHistory,
  unpublishTenantHistory,
} from '../../services/communeLaunchService.js'

const TENANT = { tenantId: 'tenant-1', tenantName: 'Chartres' }

/**
 * Monte les trois tables que le lancement touche.
 *
 * `waiting` est la liste d'attente non encore prévenue ; `notified` recueille
 * les identifiants réellement marqués, pour vérifier qu'une adresse refusée
 * n'est pas comptée comme traitée.
 */
function mockTables({
  unpublished = [] as { id: string }[],
  territories = [{ insee_code: '28085' }],
  waiting = [] as { id: string; email: string; commune_name: string | null }[],
  waitlistError = null as object | null,
}) {
  const notified: string[] = []

  const reportsUpdate = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ data: unpublished, error: null }),
      }),
    }),
  })

  const territoriesSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ data: territories, error: null }),
  })

  const waitlistSelect = vi.fn().mockReturnValue({
    in: vi.fn().mockReturnValue({
      is: vi.fn().mockResolvedValue({ data: waiting, error: waitlistError }),
    }),
  })

  const waitlistUpdate = vi.fn().mockImplementation(() => ({
    eq: vi.fn().mockImplementation((_column: string, id: string) => {
      notified.push(id)
      return Promise.resolve({ error: null })
    }),
  }))

  vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    if (table === 'reports') return { update: reportsUpdate } as never
    if (table === 'tenant_territories') return { select: territoriesSelect } as never
    if (table === 'commune_waitlist') {
      return { select: waitlistSelect, update: waitlistUpdate } as never
    }
    throw new Error(`table inattendue : ${table}`)
  })

  return { notified, reportsUpdate }
}

beforeEach(() => {
  vi.clearAllMocks()
  send.mockResolvedValue({ error: null })
})

describe('publishTenantHistory', () => {
  it('publishes the reports received while the commune was a prospect', async () => {
    mockTables({ unpublished: [{ id: 'r1' }, { id: 'r2' }] })

    expect(await publishTenantHistory('tenant-1')).toBe(2)
  })

  it('reports nothing published when there is no history', async () => {
    mockTables({ unpublished: [] })

    expect(await publishTenantHistory('tenant-1')).toBe(0)
  })
})

describe('unpublishTenantHistory', () => {
  /**
   * Le retour au silence : une commune partenaire qui s'en va, ou une commune
   * citoyenne qu'on referme. Laisser public l'inventaire d'une commune qui a
   * cessé de payer ferait du non-renouvellement un moyen de pression.
   */
  it('takes every published report back out of sight', async () => {
    const { reportsUpdate } = mockTables({ unpublished: [{ id: 'r1' }, { id: 'r2' }] })

    expect(await unpublishTenantHistory('tenant-1')).toBe(2)
    expect(reportsUpdate).toHaveBeenCalledWith({ is_published: false })
  })

  it('reports nothing hidden when the commune published nothing', async () => {
    mockTables({ unpublished: [] })

    expect(await unpublishTenantHistory('tenant-1')).toBe(0)
  })
})

describe('notifyCommuneWaitlist', () => {
  it('writes to everyone still waiting', async () => {
    const { notified } = mockTables({
      waiting: [
        { id: 'w1', email: 'a@exemple.fr', commune_name: 'Chartres' },
        { id: 'w2', email: 'b@exemple.fr', commune_name: 'Chartres' },
      ],
    })

    expect(await notifyCommuneWaitlist(TENANT)).toEqual({ sent: 2, failed: 0 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(notified).toEqual(['w1', 'w2'])
  })

  // Marquer en bloc ferait disparaître l'adresse refusée de la liste : elle ne
  // serait jamais prévenue, et rien ne le dirait.
  it('leaves a refused address to be notified later', async () => {
    const { notified } = mockTables({
      waiting: [
        { id: 'w1', email: 'a@exemple.fr', commune_name: 'Chartres' },
        { id: 'w2', email: 'refuse@exemple.fr', commune_name: 'Chartres' },
      ],
    })
    send.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({
      error: { message: 'adresse invalide' },
    })

    expect(await notifyCommuneWaitlist(TENANT)).toEqual({ sent: 1, failed: 1 })
    expect(notified).toEqual(['w1'])
  })

  it('sends nothing when the waitlist is empty', async () => {
    mockTables({ waiting: [] })

    expect(await notifyCommuneWaitlist(TENANT)).toEqual({ sent: 0, failed: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  // Sans territoire, aucun code INSEE : la liste d'attente est indexée dessus.
  it('sends nothing when the tenant covers no commune', async () => {
    mockTables({ territories: [] })

    expect(await notifyCommuneWaitlist(TENANT)).toEqual({ sent: 0, failed: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('prefers the commune name left at sign-up over the tenant name', async () => {
    mockTables({
      waiting: [{ id: 'w1', email: 'a@exemple.fr', commune_name: 'Chartres-de-Bretagne' }],
    })

    await notifyCommuneWaitlist({ tenantId: 'tenant-1', tenantName: 'Ville de Chartres' })

    expect(send.mock.calls[0][0].subject).toContain('Chartres-de-Bretagne')
  })
})
