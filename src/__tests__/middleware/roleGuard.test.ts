import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { AppError } from '../../middleware/errorHandler.js'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        getUserById: vi.fn(),
      },
    },
    from: vi.fn(),
  },
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { requireTenantAdmin, requireSuperAdmin, requireAgent, roleCache } from '../../middleware/roleGuard.js'

const TENANT = {
  id: 'tenant-1',
  slug: 'dreux',
  name: 'Dreux',
  status: 'active' as const,
  plan: 'starter' as const,
  created_at: '',
  updated_at: '',
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    userId: 'user-123',
    userRole: 'citizen',
    tenant: TENANT,
    ...overrides,
  } as unknown as Request
}

function mockAuthUser(role: string | null) {
  vi.mocked(supabaseAdmin.auth.admin.getUserById).mockResolvedValue({
    data: {
      user: role
        ? { id: 'user-123', app_metadata: { role } } as any
        : { id: 'user-123', app_metadata: {} } as any,
    },
    error: null,
  })
}

function mockTenantUser(role: string | null) {
  const single = vi.fn().mockResolvedValue({
    data: role ? { role, is_active: true } : null,
    error: null,
  })
  const eq2 = vi.fn().mockReturnValue({ single })
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 })
  const select = vi.fn().mockReturnValue({ eq: eq1 })
  vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as any)
}

describe('requireSuperAdmin', () => {
  const next = vi.fn() as unknown as NextFunction
  beforeEach(() => { vi.clearAllMocks(); roleCache.clear() })

  it('passes when app_metadata.role is super_admin', async () => {
    mockAuthUser('super_admin')
    const req = makeReq()
    await (requireSuperAdmin as Function)(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith()
  })

  it('calls next(AppError 403) when app_metadata.role is not super_admin', async () => {
    mockAuthUser(null)
    mockTenantUser('admin')
    const req = makeReq()
    await (requireSuperAdmin as Function)(req, {} as Response, next)
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError
    expect(err.status).toBe(403)
  })

  it('calls next(AppError 401) when userId is missing', async () => {
    const req = makeReq({ userId: undefined } as any)
    await (requireSuperAdmin as Function)(req, {} as Response, next)
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError
    expect(err.status).toBe(401)
  })
})

describe('requireTenantAdmin', () => {
  const next = vi.fn() as unknown as NextFunction
  beforeEach(() => { vi.clearAllMocks(); roleCache.clear() })

  it('passes as super_admin without querying tenant_users', async () => {
    mockAuthUser('super_admin')
    const req = makeReq()
    await (requireTenantAdmin as Function)(req, {} as Response, next)
    expect(supabaseAdmin.from).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith()
  })

  it('passes when DB role is admin', async () => {
    mockAuthUser(null)
    mockTenantUser('admin')
    const req = makeReq()
    await (requireTenantAdmin as Function)(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith()
  })

  it('calls next(AppError 403) when DB role is agent (insufficient for admin)', async () => {
    mockAuthUser(null)
    mockTenantUser('agent')
    const req = makeReq()
    await (requireTenantAdmin as Function)(req, {} as Response, next)
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError
    expect(err.status).toBe(403)
    expect(err.code).toBe('forbidden')
  })

  it('calls next(AppError 403) when user is not in tenant_users', async () => {
    mockAuthUser(null)
    mockTenantUser(null)
    const req = makeReq()
    await (requireTenantAdmin as Function)(req, {} as Response, next)
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError
    expect(err.status).toBe(403)
  })

  it('calls next(AppError 401) when userId is missing', async () => {
    const req = makeReq({ userId: undefined } as any)
    await (requireTenantAdmin as Function)(req, {} as Response, next)
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError
    expect(err.status).toBe(401)
  })
})

describe('requireAgent', () => {
  const next = vi.fn() as unknown as NextFunction
  beforeEach(() => { vi.clearAllMocks(); roleCache.clear() })

  it('passes when DB role is admin', async () => {
    mockAuthUser(null)
    mockTenantUser('admin')
    const req = makeReq()
    await (requireAgent as Function)(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith()
  })

  it('passes when DB role is agent', async () => {
    mockAuthUser(null)
    mockTenantUser('agent')
    const req = makeReq()
    await (requireAgent as Function)(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith()
  })

  it('calls next(AppError 403) when DB role is observer', async () => {
    mockAuthUser(null)
    mockTenantUser('observer')
    const req = makeReq()
    await (requireAgent as Function)(req, {} as Response, next)
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError
    expect(err.status).toBe(403)
  })
})
