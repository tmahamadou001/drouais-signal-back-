import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { AppError } from '../../middleware/errorHandler.js'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { resolveTenant, requireTenant, invalidateTenantCache } from '../../middleware/tenantResolver.js'

const ACTIVE_TENANT = {
  id: 'tenant-1',
  slug: 'dreux',
  name: 'Dreux',
  status: 'active',
  plan: 'starter',
  created_at: '',
  updated_at: '',
}

function mockTenantQuery(tenant: object | null, error: object | null = null) {
  const single = vi.fn().mockResolvedValue({ data: tenant, error })
  const eq = vi.fn().mockReturnValue({ single })
  const select = vi.fn().mockReturnValue({ eq })
  vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as any)
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    hostname: 'localhost',
    query: {},
    ...overrides,
  } as unknown as Request
}

describe('resolveTenant', () => {
  const next = vi.fn() as unknown as NextFunction

  beforeEach(() => {
    vi.clearAllMocks()
    invalidateTenantCache('dreux')
    invalidateTenantCache('inconnu')
  })

  it('resolves tenant from X-Tenant-Slug header', async () => {
    mockTenantQuery(ACTIVE_TENANT)
    const req = makeReq({ headers: { 'x-tenant-slug': 'dreux' } })
    await resolveTenant(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith()
    expect((req as any).tenant).toMatchObject({ slug: 'dreux', status: 'active' })
  })

  it('calls next(AppError 404) when tenant is not found', async () => {
    mockTenantQuery(null, { message: 'not found' })
    const req = makeReq({ headers: { 'x-tenant-slug': 'inconnu' } })
    await resolveTenant(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith(expect.any(AppError))
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError
    expect(err.status).toBe(404)
    expect(err.code).toBe('not_found')
  })

  it('calls next(AppError 403) when tenant is suspended', async () => {
    mockTenantQuery({ ...ACTIVE_TENANT, status: 'suspended' })
    const req = makeReq({ headers: { 'x-tenant-slug': 'dreux' } })
    await resolveTenant(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith(expect.any(AppError))
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError
    expect(err.status).toBe(403)
    expect(err.code).toBe('suspended')
  })

  it('calls next() without setting tenant when no slug is provided', async () => {
    const req = makeReq()
    await resolveTenant(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith()
    expect((req as any).tenant).toBeUndefined()
  })

  it('serves subsequent requests from cache without hitting the DB', async () => {
    mockTenantQuery(ACTIVE_TENANT)
    const req1 = makeReq({ headers: { 'x-tenant-slug': 'dreux' } })
    const req2 = makeReq({ headers: { 'x-tenant-slug': 'dreux' } })
    await resolveTenant(req1, {} as Response, next)
    await resolveTenant(req2, {} as Response, next)
    expect(supabaseAdmin.from).toHaveBeenCalledTimes(1)
  })
})

describe('requireTenant', () => {
  const next = vi.fn() as unknown as NextFunction
  beforeEach(() => vi.clearAllMocks())

  it('passes when req.tenant is defined', () => {
    const req = makeReq({ tenant: ACTIVE_TENANT } as any)
    requireTenant(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith()
  })

  it('calls next(AppError 400) when req.tenant is missing', () => {
    const req = makeReq()
    requireTenant(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith(expect.any(AppError))
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError
    expect(err.status).toBe(400)
    expect(err.code).toBe('bad_request')
  })
})
