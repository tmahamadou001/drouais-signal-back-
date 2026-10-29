import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import {
  isPlausiblePosition,
  resolveCommune,
  tenantForInsee,
  parentCommuneCode,
  resolve,
  clearGeoCache,
} from '../../services/geoRouting.js'

const DREUX = { id: 'tenant-dreux', slug: 'dreux', name: 'Dreux', status: 'active' }

/** Une réponse BAN telle que l'API la rend pour un point dans Dreux. */
function banHit(citycode = '28134', city = 'Dreux') {
  return {
    ok: true,
    json: async () => ({
      features: [{ properties: { citycode, city, label: '1 Rue de la Gare 28100 Dreux' } }],
    }),
  }
}

/** Une réponse geo.api.gouv.fr, qui ne porte pas d'adresse. */
function geoApiHit(code = '28134', nom = 'Dreux') {
  return { ok: true, json: async () => [{ code, nom }] }
}

function mockTerritoryQuery(row: object | null, error: object | null = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error })
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as never)
}

beforeEach(() => {
  clearGeoCache()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isPlausiblePosition', () => {
  it('accepts a point in mainland France and one overseas', () => {
    expect(isPlausiblePosition(48.737, 1.365)).toBe(true)   // Dreux
    expect(isPlausiblePosition(-20.88, 55.45)).toBe(true)   // Saint-Denis de La Réunion
  })

  it('rejects (0, 0), which is what a sensor without a fix returns', () => {
    expect(isPlausiblePosition(0, 0)).toBe(false)
  })

  it('rejects NaN and Infinity, which parsing a string can produce', () => {
    expect(isPlausiblePosition(NaN, 1.365)).toBe(false)
    expect(isPlausiblePosition(48.737, Infinity)).toBe(false)
  })

  it('rejects a point outside French territory', () => {
    expect(isPlausiblePosition(40.71, -74.0)).toBe(false)   // New York
    expect(isPlausiblePosition(52.52, 13.4)).toBe(false)    // Berlin
  })
})

describe('resolveCommune', () => {
  it('reads the INSEE code and the address from the BAN', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(banHit()))

    const commune = await resolveCommune(48.737, 1.365)

    expect(commune).toEqual({
      inseeCode: '28134',
      communeName: 'Dreux',
      addressLabel: '1 Rue de la Gare 28100 Dreux',
    })
  })

  it('falls back to geo.api.gouv.fr when the BAN is down', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce(geoApiHit())
    vi.stubGlobal('fetch', fetchMock)

    const commune = await resolveCommune(48.737, 1.365)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(commune?.inseeCode).toBe('28134')
    // Ce fournisseur ne rend pas d'adresse : le champ doit être nul, pas absent.
    expect(commune?.addressLabel).toBeNull()
  })

  it('answers null rather than throwing when both providers fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await expect(resolveCommune(48.737, 1.365)).resolves.toBeNull()
  })

  it('calls no provider for an implausible position', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await resolveCommune(0, 0)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves two points on the same pavement from cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue(banHit())
    vi.stubGlobal('fetch', fetchMock)

    await resolveCommune(48.737012, 1.365034)
    await resolveCommune(48.737019, 1.365041) // ~1 m plus loin

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failure, so a brief outage does not last 24 hours', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))  // BAN
      .mockRejectedValueOnce(new Error('timeout'))  // geo.api
      .mockResolvedValue(banHit())
    vi.stubGlobal('fetch', fetchMock)

    expect(await resolveCommune(48.737, 1.365)).toBeNull()
    expect((await resolveCommune(48.737, 1.365))?.inseeCode).toBe('28134')
  })
})

describe('tenantForInsee', () => {
  it('returns the tenant covering the commune', async () => {
    mockTerritoryQuery({ tenants: DREUX })
    expect(await tenantForInsee('28134')).toMatchObject({ slug: 'dreux' })
  })

  it('accepts the relation returned as an array by PostgREST', async () => {
    mockTerritoryQuery({ tenants: [DREUX] })
    expect(await tenantForInsee('28134')).toMatchObject({ slug: 'dreux' })
  })

  it('returns null for an uncovered commune', async () => {
    mockTerritoryQuery(null)
    expect(await tenantForInsee('75056')).toBeNull()
  })

  it('returns null without throwing when the database errors', async () => {
    mockTerritoryQuery(null, { message: 'connection reset' })
    await expect(tenantForInsee('28134')).resolves.toBeNull()
  })
})

describe('parentCommuneCode', () => {
  it('maps an arrondissement to its city', () => {
    expect(parentCommuneCode('75104')).toBe('75056') // Paris 4e
    expect(parentCommuneCode('69382')).toBe('69123') // Lyon 2e
    expect(parentCommuneCode('13201')).toBe('13055') // Marseille 1er
  })

  it('returns null for an ordinary commune', () => {
    expect(parentCommuneCode('28134')).toBeNull() // Dreux
    expect(parentCommuneCode('2A004')).toBeNull() // Corse, code non numérique
  })

  it('returns null just outside the ranges', () => {
    expect(parentCommuneCode('75121')).toBeNull()
    expect(parentCommuneCode('69380')).toBeNull()
  })
})

describe('tenantForInsee — Paris, Lyon and Marseille', () => {
  it('finds a city-wide tenant from an arrondissement code', async () => {
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })              // 75104 : rien
      .mockResolvedValueOnce({ data: { tenants: DREUX }, error: null }) // 75056 : la ville
    const eq = vi.fn().mockReturnValue({ maybeSingle })
    const select = vi.fn().mockReturnValue({ eq })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as never)

    expect(await tenantForInsee('75104')).toMatchObject({ slug: 'dreux' })
    expect(maybeSingle).toHaveBeenCalledTimes(2)
  })

  it('prefers the arrondissement when declared, with no extra query', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { tenants: DREUX }, error: null })
    const eq = vi.fn().mockReturnValue({ maybeSingle })
    const select = vi.fn().mockReturnValue({ eq })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as never)

    await tenantForInsee('75104')
    expect(maybeSingle).toHaveBeenCalledTimes(1)
  })
})

describe('resolve', () => {
  it('assembles commune and tenant', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(banHit()))
    mockTerritoryQuery({ tenants: DREUX })

    const location = await resolve(48.737, 1.365)

    expect(location?.inseeCode).toBe('28134')
    expect(location?.tenant).toMatchObject({ slug: 'dreux' })
  })

  it('returns the commune with a null tenant when it is uncovered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(banHit('75056', 'Paris')))
    mockTerritoryQuery(null)

    const location = await resolve(48.857, 2.295)

    // Ce n'est pas une erreur : c'est un signalement en commune prospect, que
    // la phase 2 sait accueillir. Le distinguer d'un échec de géocodage est
    // tout l'intérêt de ce contrat.
    expect(location?.communeName).toBe('Paris')
    expect(location?.tenant).toBeNull()
  })

  it('returns null when the commune itself cannot be found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    await expect(resolve(48.737, 1.365)).resolves.toBeNull()
  })
})
