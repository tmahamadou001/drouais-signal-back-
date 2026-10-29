import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn().mockResolvedValue({ error: null }), storage: { from: vi.fn() } },
}))
vi.mock('../../services/geoRouting.js', () => ({
  resolve: vi.fn(),
  isPlausiblePosition: (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng),
}))
vi.mock('../../services/categoryService.js', () => ({ resolveCategories: vi.fn() }))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { resolve as resolveLocation } from '../../services/geoRouting.js'
import { resolveCategories } from '../../services/categoryService.js'
import { createManualReport } from '../../services/manualReportService.js'

const TENANT = 'tenant-la-loupe'
const INPUT = { title: 'Potelet arraché', category: 'voirie', lat: 48.47, lng: 1.0 }

/** The row `reports` is asked to insert, captured for assertions. */
let inserted: Record<string, unknown> | null = null

/** `tenant_territories` answers whether the commune covers that INSEE code. */
function mockTables(covers: boolean) {
  inserted = null

  vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    if (table === 'tenant_territories') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: covers ? { insee_code: '28211' } : null }),
      }
      return chain
    }

    const chain: any = {
      insert: (row: Record<string, unknown>) => {
        inserted = row
        return chain
      },
      select: () => chain,
      single: async () => ({ data: { id: 'report-1', reference: 'LAL-2026-00042' }, error: null }),
    }
    return chain
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveLocation).mockResolvedValue({
    inseeCode: '28211',
    communeName: 'La Loupe',
    addressLabel: '1 Rue Charles Péguy 28240 La Loupe',
    tenant: null,
  })
  vi.mocked(resolveCategories).mockResolvedValue([
    { slug: 'voirie', label: 'Voirie', is_active: true } as never,
    { slug: 'eclairage', label: 'Éclairage', is_active: false } as never,
  ])
})

describe('createManualReport', () => {
  it('files the report against the agent’s own commune', async () => {
    mockTables(true)

    const result = await createManualReport(TENANT, INPUT)

    expect(result).toEqual({ id: 'report-1', reference: 'LAL-2026-00042' })
    expect(inserted).toMatchObject({
      tenant_id: TENANT,
      source: 'agent',
      status: 'en_attente',
      is_published: true,
      insee_code: '28211',
    })
  })

  it('leaves no author, so the commune does not e-mail itself', async () => {
    // `resolveCitizenContact` reads `user_id` then `anonymous_email`. Either
    // one set here would make every status change notify the town hall — and
    // would put the report in the agent's own "Mes signalements" on mobile.
    mockTables(true)

    await createManualReport(TENANT, INPUT)

    expect(inserted).toMatchObject({
      user_id: null,
      anonymous_email: null,
      anonymous_token: null,
      is_anonymous: false,
    })
  })

  it('keeps the address the BAN returned, not the one asked for', async () => {
    mockTables(true)

    await createManualReport(TENANT, INPUT)

    expect(inserted?.address_approx).toBe('1 Rue Charles Péguy 28240 La Loupe')
  })

  it('refuses a point outside the commune instead of filing it elsewhere', async () => {
    // The whole reason this is a separate route: for a citizen the position
    // decides the commune, for an agent the commune is known and the position
    // must be inside it. A pin dropped across the boundary must not write into
    // the neighbour's tenant, nor spawn a prospect for a town that asked for
    // nothing.
    mockTables(false)

    await expect(createManualReport(TENANT, INPUT)).rejects.toMatchObject({
      status: 422,
      code: 'outside_territory',
    })
    expect(inserted).toBeNull()
  })

  it('refuses a category the commune has switched off', async () => {
    mockTables(true)

    await expect(
      createManualReport(TENANT, { ...INPUT, category: 'eclairage' })
    ).rejects.toMatchObject({ status: 400 })
  })

  it('fails closed when the position cannot be resolved', async () => {
    mockTables(true)
    vi.mocked(resolveLocation).mockResolvedValue(null)

    await expect(createManualReport(TENANT, INPUT)).rejects.toMatchObject({
      status: 503,
      code: 'geocoding_unavailable',
    })
  })
})
