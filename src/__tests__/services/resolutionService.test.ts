import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: {
    from: vi.fn(),
    auth: { admin: { getUserById: vi.fn() } },
  },
}))

vi.mock('../../services/pushService.js', () => ({
  pushResidentResolution: vi.fn().mockResolvedValue(undefined),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { pushResidentResolution } from '../../services/pushService.js'
import {
  claimResolution,
  decideFlip,
  RESOLUTION_RADIUS_M,
} from '../../services/resolutionService.js'

/**
 * Qui ferme un signalement là où il n'y a pas de mairie.
 *
 * Chaque test ci-dessous correspond à une façon précise de détourner le geste :
 * le fermer depuis chez soi, le fermer chez une commune partenaire à la place
 * des agents, le fermer seul alors qu'on passait par là, ou faire compter deux
 * fois son propre constat.
 */

const REPORT_ID = 'report-1'
const AUTHOR = 'author-1'
const PASSERBY = 'passerby-1'

/** Mairie de Dreux, et un point à ~40 m. */
const HERE = { lat: 48.7322, lng: 1.3664 }
const NEARBY = { lat: 48.73256, lng: 1.3664 }
/** Place de la Concorde : 80 km plus loin. */
const FAR = { lat: 48.8656, lng: 2.3212 }

interface Scenario {
  tenantStatus?: string
  status?: string
  resolutionSource?: string | null
  authorId?: string | null
  claims?: { user_id: string; kind: string }[]
  /** Combien de lignes l'UPDATE conditionnel dit avoir touchées. */
  updated?: unknown[]
}

/** Monte `reports`, `tenants`, `resolution_claims` et `status_history`. */
function mockDb(scenario: Scenario = {}) {
  const spies = {
    upsert: vi.fn().mockResolvedValue({ error: null }),
    update: vi.fn(),
    history: vi.fn().mockResolvedValue({ error: null }),
  }

  const report = {
    id: REPORT_ID,
    tenant_id: 'tenant-1',
    status: scenario.status ?? 'en_attente',
    resolution_source: scenario.resolutionSource ?? null,
    user_id: scenario.authorId === undefined ? AUTHOR : scenario.authorId,
    lat: HERE.lat,
    lng: HERE.lng,
    title: 'Nid-de-poule',
    category: 'voirie',
    address_approx: null,
    photo_url: null,
    created_at: '2026-01-01T00:00:00Z',
    is_anonymous: false,
    anonymous_token: null,
  }

  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table === 'reports') {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        single: () => Promise.resolve({ data: report, error: null }),
        update: (values: unknown) => {
          spies.update(values)
          const after: Record<string, unknown> = {}
          Object.assign(after, {
            eq: () => after,
            select: () => Promise.resolve({ data: scenario.updated ?? [{ id: REPORT_ID }], error: null }),
          })
          return after
        },
      })
      return chain
    }

    if (table === 'tenants') {
      return {
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({ data: { status: scenario.tenantStatus ?? 'community' }, error: null }),
          }),
        }),
      }
    }

    if (table === 'resolution_claims') {
      return {
        upsert: spies.upsert,
        select: () => ({
          eq: () => Promise.resolve({ data: scenario.claims ?? [], error: null }),
        }),
      }
    }

    if (table === 'status_history') return { insert: spies.history }

    return {}
  }) as never)

  return spies
}

/** Un compte confirmé et assez ancien : le cas nominal d'un habitant. */
function accountAged(days: number, confirmed = true) {
  vi.mocked(supabaseAdmin.auth.admin.getUserById).mockResolvedValue({
    data: {
      user: {
        id: PASSERBY,
        created_at: new Date(Date.now() - days * 86_400_000).toISOString(),
        email_confirmed_at: confirmed ? '2026-01-01T00:00:00Z' : null,
      },
    },
    error: null,
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  accountAged(30)
})

describe('decideFlip', () => {
  it('lets the author close their own report alone', () => {
    expect(decideFlip({ claimantId: AUTHOR, authorId: AUTHOR, concurring: [AUTHOR] })).toBe(true)
  })

  /** Un passant se trompe de bonne foi : le trou rebouché était celui d'à côté. */
  it('refuses a single passer-by', () => {
    expect(decideFlip({ claimantId: PASSERBY, authorId: AUTHOR, concurring: [PASSERBY] })).toBe(false)
  })

  it('accepts two concurring residents', () => {
    expect(
      decideFlip({ claimantId: PASSERBY, authorId: AUTHOR, concurring: [PASSERBY, 'other'] })
    ).toBe(true)
  })

  /** Le même constat déposé deux fois reste un constat. */
  it('does not count the same resident twice', () => {
    expect(
      decideFlip({ claimantId: PASSERBY, authorId: AUTHOR, concurring: [PASSERBY, PASSERBY] })
    ).toBe(false)
  })

  /**
   * Un signalement déposé sans compte n'a pas d'auteur reconnaissable : il
   * retombe sur la règle commune plutôt que d'ouvrir une porte à qui prétend
   * l'être.
   */
  it('has no author shortcut for a report filed without an account', () => {
    expect(decideFlip({ claimantId: PASSERBY, authorId: null, concurring: [PASSERBY] })).toBe(false)
  })
})

describe('claimResolution', () => {
  const claim = (over: Partial<Parameters<typeof claimResolution>[0]> = {}) =>
    claimResolution({
      reportId: REPORT_ID,
      userId: PASSERBY,
      lat: NEARBY.lat,
      lng: NEARBY.lng,
      kind: 'repaired',
      photoUrl: 'https://photos/1.jpg',
      ...over,
    })

  it('refuses a claim made from far away', async () => {
    mockDb()

    await expect(claim({ lat: FAR.lat, lng: FAR.lng })).rejects.toMatchObject({
      status: 422,
      code: 'too_far',
    })
  })

  /** Le rayon est celui des confirmations sur place : c'est le même geste. */
  it('keeps the same radius as an on-site confirmation', () => {
    expect(RESOLUTION_RADIUS_M).toBe(150)
  })

  /**
   * Dans une commune partenaire, la décision appartient aux agents : c'est ce
   * que la mairie a acheté, et sa file ne doit pas se vider sans elle.
   */
  it('refuses the gesture in a partner commune', async () => {
    mockDb({ tenantStatus: 'active' })

    await expect(claim()).rejects.toMatchObject({ status: 403, code: 'not_community' })
  })

  it('refuses it in a silent commune, where nothing is published either', async () => {
    mockDb({ tenantStatus: 'prospect' })

    await expect(claim()).rejects.toMatchObject({ status: 403, code: 'not_community' })
  })

  it('records a claim without closing when a single passer-by reports a repair', async () => {
    const spies = mockDb({ claims: [{ user_id: PASSERBY, kind: 'repaired' }] })

    const state = await claim()

    expect(spies.upsert).toHaveBeenCalled()
    expect(spies.update).not.toHaveBeenCalled()
    expect(state.status).toBe('en_attente')
    expect(state.repaired_count).toBe(1)
  })

  it('closes the report when the author says it is repaired', async () => {
    const spies = mockDb({ claims: [{ user_id: AUTHOR, kind: 'repaired' }] })

    const state = await claim({ userId: AUTHOR })

    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolu', resolution_source: 'residents' })
    )
    expect(state.status).toBe('resolu')
  })

  it('closes it on a second concurring resident', async () => {
    const spies = mockDb({
      claims: [
        { user_id: PASSERBY, kind: 'repaired' },
        { user_id: 'other', kind: 'repaired' },
      ],
    })

    await claim()

    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolu', resolution_source: 'residents' })
    )
  })

  /** Personne de la mairie n'a rien décidé : le journal ne doit nommer aucun agent. */
  it('writes the history entry without an agent', async () => {
    const spies = mockDb({ claims: [{ user_id: AUTHOR, kind: 'repaired' }] })

    await claim({ userId: AUTHOR })

    expect(spies.history).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: null, new_status: 'resolu' })
    )
  })

  it('refuses to repair a report that is already resolved', async () => {
    mockDb({ status: 'resolu', resolutionSource: 'residents' })

    await expect(claim()).rejects.toMatchObject({ status: 409, code: 'already_resolved' })
  })

  describe('contesting', () => {
    const contest = (over = {}) => claim({ kind: 'still_there', photoUrl: null, ...over })

    it('reopens when the author says it is still there', async () => {
      const spies = mockDb({
        status: 'resolu',
        resolutionSource: 'residents',
        claims: [{ user_id: AUTHOR, kind: 'still_there' }],
      })

      const state = await contest({ userId: AUTHOR })

      expect(spies.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'en_attente', resolution_source: null })
      )
      expect(state.status).toBe('en_attente')
    })

    /**
     * Une décision de la commune ne se conteste pas par ce chemin : si elle a
     * signé entre-temps, l'habitant passe par la conversation avec la mairie.
     */
    it('refuses to contest a decision made by the town hall', async () => {
      mockDb({ status: 'resolu', resolutionSource: 'agent' })

      await expect(contest()).rejects.toMatchObject({
        status: 409,
        code: 'not_resident_resolved',
      })
    })

    it('refuses to contest a report nobody has closed', async () => {
      mockDb({ status: 'en_attente' })

      await expect(contest()).rejects.toMatchObject({ code: 'not_resident_resolved' })
    })
  })

  describe('telling the author', () => {
    it('notifies them when neighbours close their report', async () => {
      mockDb({
        claims: [
          { user_id: PASSERBY, kind: 'repaired' },
          { user_id: 'other', kind: 'repaired' },
        ],
      })

      await claim()

      expect(pushResidentResolution).toHaveBeenCalledWith(
        expect.objectContaining({ userId: AUTHOR, reopened: false })
      )
    })

    /** Il vient de le faire lui-même : le prévenir n'apprendrait rien. */
    it('stays quiet when the author is the one who acted', async () => {
      mockDb({ claims: [{ user_id: AUTHOR, kind: 'repaired' }] })

      await claim({ userId: AUTHOR })

      expect(pushResidentResolution).not.toHaveBeenCalled()
    })

    /** Un dépôt sans compte n'a aucun appareil à prévenir. */
    it('stays quiet for a report filed without an account', async () => {
      mockDb({
        authorId: null,
        claims: [
          { user_id: PASSERBY, kind: 'repaired' },
          { user_id: 'other', kind: 'repaired' },
        ],
      })

      await claim()

      expect(pushResidentResolution).not.toHaveBeenCalled()
    })

    it('says so when the report is reopened instead', async () => {
      mockDb({
        status: 'resolu',
        resolutionSource: 'residents',
        claims: [
          { user_id: PASSERBY, kind: 'still_there' },
          { user_id: 'other', kind: 'still_there' },
        ],
      })

      await claim({ kind: 'still_there', photoUrl: null })

      expect(pushResidentResolution).toHaveBeenCalledWith(
        expect.objectContaining({ reopened: true })
      )
    })
  })

  /**
   * Deux inscriptions gratuites fermaient le signalement d'autrui : la session
   * anonyme était refusée, mais `register` est ouvert et rien n'empêchait
   * d'ouvrir deux comptes dans la minute.
   */
  describe('whose claim counts', () => {
    it('refuses a brand-new account', async () => {
      mockDb()
      accountAged(1)

      await expect(claim()).rejects.toMatchObject({ status: 403, code: 'account_too_new' })
    })

    it('refuses an account whose address was never confirmed', async () => {
      mockDb()
      accountAged(60, false)

      await expect(claim()).rejects.toMatchObject({ code: 'account_too_new' })
    })

    it('refuses before anything is written', async () => {
      const spies = mockDb()
      accountAged(1)

      await claim().catch(() => undefined)

      expect(spies.upsert).not.toHaveBeenCalled()
    })

    /** L'auteur ferme le sien quel que soit l'âge de son compte. */
    it('never holds the author to that rule', async () => {
      const spies = mockDb({ claims: [{ user_id: AUTHOR, kind: 'repaired' }] })
      accountAged(0, false)

      const state = await claim({ userId: AUTHOR })

      expect(state.status).toBe('resolu')
      expect(spies.upsert).toHaveBeenCalled()
    })
  })

  /**
   * Deux constats simultanés : l'UPDATE est conditionné au statut lu, donc le
   * second ne touche aucune ligne et ne doit pas écrire une seconde entrée de
   * journal ni annoncer une bascule qui n'a pas eu lieu.
   */
  it('does not log a flip that lost the race', async () => {
    const spies = mockDb({
      claims: [{ user_id: AUTHOR, kind: 'repaired' }],
      updated: [],
    })

    const state = await claim({ userId: AUTHOR })

    expect(spies.history).not.toHaveBeenCalled()
    expect(state.status).toBe('en_attente')
  })
})
