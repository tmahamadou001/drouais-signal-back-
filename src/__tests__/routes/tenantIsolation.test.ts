import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { requireTenant } from '../../middleware/tenantResolver.js'
import { AppError } from '../../middleware/errorHandler.js'

/**
 * The guard that stops commune data leaking across tenants.
 *
 * Every handler used to filter with `if (req.tenant?.id)`, so a request that
 * reached the server without a slug got *every* commune's rows. Nothing caught
 * it because the web front always sends `X-Tenant-Slug` — it took the mobile
 * app, which has no commune on first launch, to surface 35 reports from four
 * towns in one list.
 *
 * `requireTenant` is now mounted on every commune-scoped path in `index.ts`.
 * These tests pin the behaviour it depends on.
 */
function run(req: Partial<Request>): { error: unknown; passed: boolean } {
  let error: unknown = null
  let passed = false

  const next: NextFunction = ((err?: unknown) => {
    if (err) error = err
    else passed = true
  }) as NextFunction

  requireTenant(req as Request, {} as Response, next)

  return { error, passed }
}

describe('requireTenant', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lets a resolved tenant through', () => {
    const { passed, error } = run({ tenant: { id: 'abc', slug: 'dreux' } as never })

    expect(passed).toBe(true)
    expect(error).toBeNull()
  })

  it('refuses a request with no tenant rather than serving every commune', () => {
    // The whole point: an unscoped read must fail loudly, not quietly return
    // the union of every town's data.
    const { passed, error } = run({})

    expect(passed).toBe(false)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(400)
    expect((error as AppError).code).toBe('bad_request')
  })

  it('treats an undefined tenant the same as an absent one', () => {
    const { passed } = run({ tenant: undefined })

    expect(passed).toBe(false)
  })
})
