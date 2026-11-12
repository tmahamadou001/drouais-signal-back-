import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

vi.mock('../../lib/photoStorage.js', () => ({
  removePhoto: vi.fn().mockResolvedValue(true),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { removePhoto } from '../../lib/photoStorage.js'
import {
  listModerationQueue,
  retractReport,
  restoreReport,
  removeReportPhoto,
} from '../../services/moderationService.js'

/**
 * Ce que la modération peut toucher, et ce qu'elle ne doit pas toucher.
 *
 * Le périmètre est la moitié du sujet : ces gestes existent parce qu'une
 * commune ouverte au public n'a personne pour modérer. Les laisser porter sur
 * une commune partenaire ferait disparaître une ligne de la file d'un agent
 * sans que personne chez elle ne l'ait décidé ni ne puisse le comprendre.
 */

const REPORT = {
  id: 'report-1',
  title: 'Nid-de-poule',
  photo_url: 'https://supabase/storage/v1/object/sign/photos/reports/a.jpg?token=x',
  is_published: true,
  tenant_id: 'tenant-1',
}

function mockReport(over: Record<string, unknown> = {}, tenantStatus = 'community') {
  const update = vi.fn()

  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table !== 'reports') return {}

    const chain: Record<string, unknown> = {}
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      single: () =>
        Promise.resolve({
          data: { ...REPORT, ...over, tenants: { status: tenantStatus, slug: 'senonches-28373' } },
          error: null,
        }),
      update: (values: unknown) => {
        update(values)
        return { eq: () => Promise.resolve({ error: null }) }
      },
    })
    return chain
  }) as never)

  return { update }
}

beforeEach(() => vi.clearAllMocks())

describe('retracting a report', () => {
  it('takes it out of sight without deleting it', async () => {
    const { update } = mockReport()

    await retractReport('report-1')

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ is_published: false }))
  })

  /**
   * `is_published` portait deux sens incompatibles : « jamais publié, la
   * commune est silencieuse » et « retiré par un modérateur ». Rouvrir une
   * commune republiait donc ce qu'on venait d'en retirer.
   */
  it('marks why it is unpublished, not merely that it is', async () => {
    const { update } = mockReport()

    await retractReport('report-1')

    expect(update.mock.calls[0][0]).toHaveProperty('retracted_at')
    expect(update.mock.calls[0][0].retracted_at).toEqual(expect.any(String))
  })

  it('clears that mark when the report is put back', async () => {
    const { update } = mockReport({ is_published: false })

    await restoreReport('report-1')

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ retracted_at: null }))
  })

  it('puts it back, because a moderation gesture that cannot be undone is not made calmly', async () => {
    const { update } = mockReport({ is_published: false })

    await restoreReport('report-1')

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ is_published: true }))
  })

  it('hands back the commune, so the trail knows where it happened', async () => {
    mockReport()

    const outcome = await retractReport('report-1')

    expect(outcome).toMatchObject({ tenantId: 'tenant-1', tenantSlug: 'senonches-28373' })
  })
})

describe('the photo alone', () => {
  /**
   * Le cas le plus fréquent, et le plus léger : une plaque, une devanture, un
   * visage. Détruire tout un signalement pour ça perdrait une information
   * publique utile et le suivi de son auteur.
   */
  it('removes the file and the link, and keeps the report', async () => {
    const { update } = mockReport()

    await removeReportPhoto('report-1')

    expect(removePhoto).toHaveBeenCalledWith(REPORT.photo_url)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ photo_url: null }))
  })

  /**
   * Effacer l'URL sans effacer le fichier laisserait l'image accessible un an
   * à qui a gardé le lien signé.
   */
  it('deletes the stored file, not just the row', async () => {
    mockReport()

    await removeReportPhoto('report-1')

    expect(removePhoto).toHaveBeenCalled()
  })

  it('says so when there is no photo to remove', async () => {
    mockReport({ photo_url: null })

    await expect(removeReportPhoto('report-1')).rejects.toMatchObject({
      status: 409,
      code: 'no_photo',
    })
  })
})

describe('what moderation may not touch', () => {
  const partners = ['active', 'trial', 'demo', 'prospect']

  for (const status of partners) {
    it(`refuses a commune in "${status}"`, async () => {
      const { update } = mockReport({}, status)

      await expect(retractReport('report-1')).rejects.toMatchObject({
        status: 409,
        code: 'not_community',
      })
      expect(update).not.toHaveBeenCalled()
    })
  }

  it('refuses a photo removal there too, before touching the storage', async () => {
    mockReport({}, 'active')

    await expect(removeReportPhoto('report-1')).rejects.toMatchObject({ code: 'not_community' })
    expect(removePhoto).not.toHaveBeenCalled()
  })

  it('says not found rather than leaking that the report exists elsewhere', async () => {
    vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
      if (table !== 'reports') return {}
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        single: () => Promise.resolve({ data: null, error: { message: 'no rows' } }),
      })
      return chain
    }) as never)

    await expect(retractReport('nope')).rejects.toMatchObject({ status: 404 })
  })
})

describe('the queue', () => {
  function mockQueue(communes: unknown[], reports: unknown[]) {
    const seen: { ids?: unknown } = {}

    vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
      if (table === 'tenants') {
        return {
          select: () => ({ eq: () => Promise.resolve({ data: communes, error: null }) }),
        }
      }

      if (table === 'reports') {
        const chain: Record<string, unknown> = {}
        Object.assign(chain, {
          select: () => chain,
          in: (_column: string, values: unknown) => {
            seen.ids = values
            return chain
          },
          order: () => chain,
          range: () => Promise.resolve({ data: reports, error: null, count: reports.length }),
        })
        return chain
      }

      return {}
    }) as never)

    return seen
  }

  it('looks only at communes that were opened to the public', async () => {
    const seen = mockQueue([{ id: 'tenant-1', slug: 's', name: 'Senonches', status: 'community' }], [])

    await listModerationQueue({ limit: 30, page: 1 })

    expect(seen.ids).toEqual(['tenant-1'])
  })

  /** Sans commune ouverte, il n'y a rien à modérer — et surtout rien à requêter. */
  it('asks for nothing when no commune is open', async () => {
    mockQueue([], [])

    const result = await listModerationQueue({ limit: 30, page: 1 })

    expect(result).toEqual({ data: [], total: 0 })
  })

  it('names the commune of each report', async () => {
    mockQueue(
      [{ id: 'tenant-1', slug: 'senonches-28373', name: 'Senonches', status: 'community' }],
      [{ id: 'report-1', title: 'Nid-de-poule', tenant_id: 'tenant-1', is_published: true }]
    )

    const { data } = await listModerationQueue({ limit: 30, page: 1 })

    expect(data[0].tenant).toEqual({ id: 'tenant-1', slug: 'senonches-28373', name: 'Senonches' })
  })

  /**
   * Les signalements retirés restent dans la file, marqués : les cacher ferait
   * du retrait une disparition, sans moyen de revenir dessus.
   */
  it('keeps retracted reports in the queue', async () => {
    mockQueue(
      [{ id: 'tenant-1', slug: 's', name: 'Senonches', status: 'community' }],
      [{ id: 'report-1', title: 'Retiré', tenant_id: 'tenant-1', is_published: false }]
    )

    const { data } = await listModerationQueue({ limit: 30, page: 1 })

    expect(data[0].is_published).toBe(false)
  })
})
