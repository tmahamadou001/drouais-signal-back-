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
import { requireTenantAdmin, requirePlatformAdmin, requireAgent, roleCache } from '../../middleware/roleGuard.js'

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

/**
 * Le rôle de plateforme ne dépend d'aucune commune.
 *
 * Il se lit dans `app_metadata`, que seule la clé `service_role` peut écrire,
 * et `verifyToken` l'a déjà posé sur la requête. Le garde précédent passait
 * par `requireRole`, donc exigeait `req.tenant` — sur des routes qui
 * travaillent justement en travers des communes.
 */
describe('requirePlatformAdmin', () => {
  const next = vi.fn() as unknown as NextFunction
  beforeEach(() => { vi.clearAllMocks(); roleCache.clear() })

  it('passes a platform role read from the token', () => {
    const req = makeReq({ userRole: 'super_admin' } as Partial<Request>)
    requirePlatformAdmin(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith()
  })

  /** Et sans aucune commune dans la requête : c'est tout l'objet du garde. */
  it('passes without any commune on the request', () => {
    const req = makeReq({ userRole: 'super_admin', tenant: undefined } as Partial<Request>)
    requirePlatformAdmin(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith()
  })

  it('refuses a commune administrator', () => {
    const req = makeReq({ userRole: 'admin' } as Partial<Request>)
    requirePlatformAdmin(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }))
  })

  it('refuses a caller with no session', () => {
    const req = makeReq({ userId: undefined } as Partial<Request>)
    requirePlatformAdmin(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }))
  })

  /** Jamais depuis `tenant_users` : le rôle de plateforme n'y a pas sa place. */
  it('does not read the role from the commune team', () => {
    mockAuthUser(null)
    mockTenantUser('super_admin')
    const req = makeReq({ userRole: 'citizen' } as Partial<Request>)
    requirePlatformAdmin(req, {} as Response, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }))
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
