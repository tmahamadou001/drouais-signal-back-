import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import { errorHandler } from '../../middleware/errorHandler.js'

/** Le rôle que le garde laisse passer, décidé par chaque test. */
let allowed = true

vi.mock('../../middleware/auth.js', () => ({
  verifyToken: (req: Request, _res: Response, next: NextFunction) => {
    req.userId = 'user-1'
    req.userRole = 'citizen'
    next()
  },
}))

vi.mock('../../middleware/roleGuard.js', () => ({
  requirePlatformAdmin: (_req: Request, res: Response, next: NextFunction) => {
    if (!allowed) return res.status(403).json({ error: 'forbidden' })
    next()
  },
  requireTenantAdmin: (_req: Request, res: Response, next: NextFunction) => {
    if (!allowed) return res.status(403).json({ error: 'forbidden' })
    next()
  },
}))

vi.mock('../../lib/supabaseAdmin.js', () => ({ supabaseAdmin: { from: vi.fn() } }))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import auditRouter from '../../routes/audit.js'

/**
 * Le journal d'audit : qui le lit, et ce qu'on peut lui faire dire.
 *
 * Deux défauts relevés par l'audit du 12 novembre 2026. La route acceptait le
 * rôle `agent` alors que la matrice réserve le journal aux administrateurs —
 * un journal qui surveille ceux qui agissent ne peut pas être lisible par eux.
 * Et son paramètre `search` entrait brut dans un `or=` PostgREST, où virgules
 * et parenthèses sont des opérateurs.
 */

/** Monte `audit_logs` et retient la clause `or` effectivement envoyée. */
function mockLogs() {
  const seen: { or?: string } = {}

  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    ilike: () => chain,
    gte: () => chain,
    lte: () => chain,
    order: () => chain,
    or: (clause: string) => {
      seen.or = clause
      return chain
    },
    range: () => Promise.resolve({ data: [], count: 0, error: null }),
  })

  vi.mocked(supabaseAdmin.from).mockReturnValue(chain as never)
  return seen
}

const app = () => {
  const instance = express()
  instance.use(express.json())
  instance.use((req: Request, _res: Response, next: NextFunction) => {
    req.tenant = { id: 'tenant-1', slug: 'dreux', name: 'Dreux', status: 'active' } as never
    next()
  })
  instance.use('/api/audit', auditRouter)
  instance.use(errorHandler)
  return instance
}

beforeEach(() => {
  allowed = true
  vi.clearAllMocks()
})

describe('who may read the audit trail', () => {
  it('goes through the admin guard', async () => {
    allowed = false
    mockLogs()

    const res = await request(app()).get('/api/audit/logs')

    expect(res.status).toBe(403)
    expect(supabaseAdmin.from).not.toHaveBeenCalled()
  })

  it('serves an administrator', async () => {
    mockLogs()

    expect((await request(app()).get('/api/audit/logs')).status).toBe(200)
  })
})

describe('the search term', () => {
  /**
   * PostgREST sépare les conditions d'un `or=` par des virgules, et groupe
   * par des parenthèses : un terme brut réécrit la clause.
   */
  it('loses the characters that are operators in a PostgREST filter', async () => {
    const seen = mockLogs()

    await request(app())
      .get('/api/audit/logs')
      .query({ search: 'a,b(c)*d%e' })

    expect(seen.or).toBeDefined()
    expect(seen.or).not.toContain('a,b')
    expect(seen.or).not.toContain('(c)')
    for (const piece of seen.or!.split('user_email.ilike.%')[1]?.split('%,') ?? []) {
      expect(piece).not.toMatch(/[(),]/)
    }
  })

  it('keeps an ordinary term, dash included', async () => {
    const seen = mockLogs()

    await request(app()).get('/api/audit/logs').query({ search: 'LAL-2026-00418' })

    expect(seen.or).toContain('LAL-2026-00418')
  })

  it('asks for no filter at all when the term is empty', async () => {
    const seen = mockLogs()

    await request(app()).get('/api/audit/logs').query({ search: '   ' })

    expect(seen.or).toBeUndefined()
  })
})
