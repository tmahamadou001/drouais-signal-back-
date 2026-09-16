import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from '../helpers/createTestApp.js'

vi.mock('../../lib/supabaseAdmin.js', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('../../middleware/rateLimits.js', () => ({
  publicTenantsLimiter: (_req: any, _res: any, next: any) => next(),
  geoResolveLimiter: (_req: any, _res: any, next: any) => next(),
}))
vi.mock('../../services/geoRouting.js', () => ({ resolve: vi.fn(), isPlausiblePosition: vi.fn() }))
vi.mock('../../services/prospectService.js', () => ({ joinWaitlist: vi.fn() }))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import tenantsRouter from '../../routes/tenants.js'

const app = () => createTestApp('/api/tenants', tenantsRouter)

/** Records the status filter the route asks for. */
function mockTenants(rows: unknown[]) {
  const seen: { statuses?: unknown } = {}
  const chain: any = {
    select: () => chain,
    in: (_column: string, values: unknown) => { seen.statuses = values; return chain },
    order: async () => ({ data: rows, error: null }),
  }
  vi.mocked(supabaseAdmin.from).mockReturnValue(chain)
  return seen
}

beforeEach(() => vi.clearAllMocks())

describe('GET /api/tenants/public', () => {
  it('lists the communes one can browse', async () => {
    mockTenants([{ slug: 'dreux', name: 'Dreux' }, { slug: 'la-loupe', name: 'La Loupe' }])

    const res = await request(app()).get('/api/tenants/public')

    expect(res.status).toBe(200)
    expect(res.body.tenants).toHaveLength(2)
  })

  /**
   * The list of our clients is readable by our competitors — that is accepted.
   * Their contract is not: no plan, no contact address, no volume.
   */
  it('exposes a name and a slug, and nothing else', async () => {
    mockTenants([{ slug: 'dreux', name: 'Dreux' }])

    const res = await request(app()).get('/api/tenants/public')

    expect(Object.keys(res.body.tenants[0]).sort()).toEqual(['name', 'slug'])
    expect(JSON.stringify(res.body)).not.toMatch(/plan|contact|email|status|count/i)
  })

  /**
   * Prospects publish nothing, so listing them would only lead to empty
   * screens; a suspended commune must not sit in a picker promising reports.
   */
  it('leaves out prospects and suspended communes', async () => {
    const seen = mockTenants([])

    await request(app()).get('/api/tenants/public')

    expect(seen.statuses).not.toContain('prospect')
    expect(seen.statuses).not.toContain('suspended')
    expect(seen.statuses).toContain('active')
  })

  /** It is how one picks a commune: demanding one first would be circular. */
  it('needs no commune of its own', async () => {
    mockTenants([{ slug: 'dreux', name: 'Dreux' }])

    const res = await request(app()).get('/api/tenants/public')

    expect(res.status).toBe(200)
  })
})
