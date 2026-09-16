import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { ensureProspectTenant, joinWaitlist } from '../../services/prospectService.js'

const CREATED = { id: 'tenant-new', slug: 'paris-75104', name: 'Paris', status: 'prospect' }
const EXISTING = { id: 'tenant-existing', slug: 'paris-75104', name: 'Paris', status: 'prospect' }

/**
 * Monte les trois tables que `ensureProspectTenant` touche.
 *
 * `territoryError` simule la course : deux signalements simultanés depuis la
 * même commune, le second perdant l'insertion du territoire.
 */
function mockTables({
  territoryError = null,
  existingTerritory = null,
  tenantError = null,
}: {
  territoryError?: object | null
  existingTerritory?: object | null
  tenantError?: object | null
} = {}) {
  const tenantInsert = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: tenantError ? null : CREATED,
        error: tenantError,
      }),
    }),
  })
  const tenantDelete = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })

  const territoryInsert = vi.fn().mockResolvedValue({ error: territoryError })
  const territorySelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: existingTerritory, error: null }),
    }),
  })

  const waitlistUpsert = vi.fn().mockResolvedValue({ error: null })

  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table === 'tenants') return { insert: tenantInsert, delete: tenantDelete }
    if (table === 'tenant_territories') return { insert: territoryInsert, select: territorySelect }
    if (table === 'commune_waitlist') return { upsert: waitlistUpsert }
    return {}
  }) as never)

  return { tenantInsert, tenantDelete, territoryInsert, waitlistUpsert }
}

beforeEach(() => vi.clearAllMocks())

describe('ensureProspectTenant', () => {
  it('creates a prospect tenant and its territory', async () => {
    const { tenantInsert, territoryInsert } = mockTables()

    const tenant = await ensureProspectTenant('75104', 'Paris')

    expect(tenant).toMatchObject({ slug: 'paris-75104' })
    expect(tenantInsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'prospect', name: 'Paris' })
    )
    expect(territoryInsert).toHaveBeenCalledWith(
      expect.objectContaining({ insee_code: '75104', commune_name: 'Paris' })
    )
  })

  it('suffixes the slug with the INSEE code', async () => {
    // Plusieurs communes françaises portent le même nom — il y a une dizaine de
    // Saint-Denis. Sans le suffixe, la seconde échouerait sur l'unicité du slug.
    const { tenantInsert } = mockTables()

    await ensureProspectTenant('97411', 'Saint-Denis')

    expect(tenantInsert).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'saint-denis-97411' })
    )
  })

  it('transliterates accents and apostrophes', async () => {
    const { tenantInsert } = mockTables()

    await ensureProspectTenant('28214', 'L’Île-d’Abeau')

    const slug = tenantInsert.mock.calls[0]![0].slug as string
    expect(slug).toMatch(/^[a-z0-9-]+$/)
    expect(slug).toContain('28214')
  })

  it('returns the existing tenant and deletes its shell when it loses the race', async () => {
    const { tenantDelete } = mockTables({
      territoryError: { code: '23505', message: 'duplicate key' },
      existingTerritory: { tenants: EXISTING },
    })

    const tenant = await ensureProspectTenant('75104', 'Paris')

    // Sans cette suppression, chaque signalement simultané laisserait un tenant
    // orphelin — invisible, sans territoire, jamais nettoyé.
    expect(tenantDelete).toHaveBeenCalled()
    expect(tenant).toMatchObject({ id: 'tenant-existing' })
  })

  it('returns null without throwing when creation fails', async () => {
    mockTables({ tenantError: { message: 'connection reset' } })
    await expect(ensureProspectTenant('75104', 'Paris')).resolves.toBeNull()
  })

  it('names the commune by its code when the BAN returned no name', async () => {
    const { tenantInsert } = mockTables()

    await ensureProspectTenant('28134', '')

    expect(tenantInsert).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'commune-28134', name: 'Commune 28134' })
    )
  })
})

describe('joinWaitlist', () => {
  it('normalises the address and ignores duplicates', async () => {
    const { waitlistUpsert } = mockTables()

    await joinWaitlist({ inseeCode: '75104', communeName: 'Paris', email: '  Marie@Exemple.FR ' })

    expect(waitlistUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'marie@exemple.fr' }),
      // Le chiffre montré à la mairie doit être un nombre d'habitants, pas un
      // nombre de clics.
      expect.objectContaining({ onConflict: 'insee_code,email', ignoreDuplicates: true })
    )
  })
})
