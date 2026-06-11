import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { errorHandler } from '../../middleware/errorHandler.js'

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: {
    from: vi.fn(),
    auth: {
      admin: {
        getUserById: vi.fn(),
        createUser: vi.fn(),
        listUsers: vi.fn(),
      },
    },
  },
}))

vi.mock('../../middleware/auth.js', () => ({
  verifyToken: (req: any, _res: any, next: any) => {
    req.userId = 'admin-user-id'
    req.userRole = 'admin'
    next()
  },
}))

vi.mock('../../middleware/tenantResolver.js', () => ({
  requireTenant: (_req: any, _res: any, next: any) => next(),
  invalidateTenantCache: vi.fn(),
}))

vi.mock('../../middleware/roleGuard.js', () => ({
  requireTenantAdmin: (req: any, _res: any, next: any) => {
    req.userId = 'admin-user-id'
    next()
  },
  requireSuperAdmin: (req: any, _res: any, next: any) => {
    req.userId = 'super-admin-id'
    next()
  },
}))

vi.mock('../../lib/authHelpers.js', () => ({
  getAuthEmailMap: vi.fn().mockResolvedValue(new Map()),
}))

vi.mock('../../services/auditService.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
  auditUserCreated: vi.fn().mockResolvedValue(undefined),
  auditTenantCreated: vi.fn().mockResolvedValue(undefined),
  auditTenantStatusChanged: vi.fn().mockResolvedValue(undefined),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { createAuditLog } from '../../services/auditService.js'
import tenantRouter from '../../routes/tenant.js'

const TENANT = {
  id: 'tenant-1',
  slug: 'dreux',
  name: 'Dreux',
  status: 'active',
  plan: 'starter',
  created_at: '',
  updated_at: '',
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => { req.tenant = TENANT; next() })
  app.use('/api/tenant', tenantRouter)
  app.use(errorHandler)
  return app
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PUT /api/tenant/categories', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when categories array is empty', async () => {
    const res = await request(makeApp())
      .put('/api/tenant/categories')
      .send({ categories: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad_request')
  })

  it('returns 400 when categories field is missing', async () => {
    const res = await request(makeApp())
      .put('/api/tenant/categories')
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad_request')
  })

  it('returns 200 and upserts categories', async () => {
    const upsertResult = [{ id: 'cat-1', slug: 'voirie', label: 'Voirie' }]
    const select = vi.fn().mockResolvedValue({ data: upsertResult, error: null })
    const upsert = vi.fn().mockReturnValue({ select })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ upsert } as any)

    const res = await request(makeApp())
      .put('/api/tenant/categories')
      .send({ categories: [{ slug: 'voirie', label: 'Voirie', icon: '🛣️', color: '#EF4444' }] })

    expect(res.status).toBe(200)
    expect(res.body).toEqual(upsertResult)
  })
})

describe('POST /api/tenant/users/invite', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when email or role is missing', async () => {
    const res = await request(makeApp())
      .post('/api/tenant/users/invite')
      .send({ email: 'test@test.com' }) // missing role
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad_request')
  })

  it('returns 201 on successful invite', async () => {
    vi.mocked(supabaseAdmin.auth.admin.createUser).mockResolvedValue({
      data: { user: { id: 'new-user-id', email: 'agent@dreux.fr' } as any },
      error: null,
    })

    const singleResult = vi.fn().mockResolvedValue({
      data: { id: 'tu-1', user_id: 'new-user-id', role: 'agent' },
      error: null,
    })
    const select  = vi.fn().mockReturnValue({ single: singleResult })
    const upsert  = vi.fn().mockReturnValue({ select })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ upsert } as any)

    const res = await request(makeApp())
      .post('/api/tenant/users/invite')
      .send({ email: 'agent@dreux.fr', role: 'agent' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ role: 'agent' })
  })
})

describe('PATCH /api/tenant/users/:userId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when user is not found in tenant', async () => {
    const single = vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } })
    const eq2    = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) })
    const eq1    = vi.fn().mockReturnValue({ eq: eq2 })
    const update = vi.fn().mockReturnValue({ eq: eq1 })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ update } as any)

    const res = await request(makeApp())
      .patch('/api/tenant/users/ghost-user')
      .send({ role: 'observer' })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
  })

  it('triggers audit log when role is changed', async () => {
    const updatedUser = { id: 'tu-1', user_id: 'user-abc', role: 'observer' }
    const single = vi.fn().mockResolvedValue({ data: updatedUser, error: null })
    const eq2    = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) })
    const eq1    = vi.fn().mockReturnValue({ eq: eq2 })
    const update = vi.fn().mockReturnValue({ eq: eq1 })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ update } as any)

    await request(makeApp())
      .patch('/api/tenant/users/user-abc')
      .send({ role: 'observer' })

    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'user.role_changed',
      entityId: 'user-abc',
      metadata: expect.objectContaining({ new_role: 'observer' }),
    }))
  })

  it('does not trigger audit log when only profile fields change', async () => {
    const updatedUser = { id: 'tu-1', user_id: 'user-abc', first_name: 'Jean' }
    const single = vi.fn().mockResolvedValue({ data: updatedUser, error: null })
    const eq2    = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) })
    const eq1    = vi.fn().mockReturnValue({ eq: eq2 })
    const update = vi.fn().mockReturnValue({ eq: eq1 })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ update } as any)

    await request(makeApp())
      .patch('/api/tenant/users/user-abc')
      .send({ firstName: 'Jean' }) // no role change

    expect(createAuditLog).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/tenant/users/:userId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 200 and triggers user.revoked audit log', async () => {
    const singleExisting = vi.fn().mockResolvedValue({ data: { role: 'agent' }, error: null })
    const eq2Existing    = vi.fn().mockReturnValue({ single: singleExisting })
    const eq1Existing    = vi.fn().mockReturnValue({ eq: eq2Existing })
    const selectExisting = vi.fn().mockReturnValue({ eq: eq1Existing })

    const eqUpdate2 = vi.fn().mockResolvedValue({ error: null })
    const eqUpdate1 = vi.fn().mockReturnValue({ eq: eqUpdate2 })
    const update    = vi.fn().mockReturnValue({ eq: eqUpdate1 })

    vi.mocked(supabaseAdmin.from).mockReturnValue({
      select: selectExisting,
      update,
    } as any)

    const res = await request(makeApp()).delete('/api/tenant/users/user-abc')

    expect(res.status).toBe(200)
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'user.revoked',
      entityId: 'user-abc',
      metadata: expect.objectContaining({ revoked_user_role: 'agent' }),
    }))
  })
})

describe('POST /api/tenant (super admin — create tenant)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when required fields are missing', async () => {
    const res = await request(makeApp())
      .post('/api/tenant')
      .send({ slug: 'new-city' }) // missing name and cityName

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad_request')
  })

  it('returns 409 when slug already exists', async () => {
    const single = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate' },
    })
    const select = vi.fn().mockReturnValue({ single })
    const insert = vi.fn().mockReturnValue({ select })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ insert } as any)

    const res = await request(makeApp())
      .post('/api/tenant')
      .send({ slug: 'dreux', name: 'Dreux', cityName: 'Dreux' })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('conflict')
  })
})

describe('PATCH /api/tenant/:tenantId/status', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 for invalid status value', async () => {
    const res = await request(makeApp())
      .patch('/api/tenant/tenant-1/status')
      .send({ status: 'unknown_status' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad_request')
  })

  it('returns 200 on valid status change', async () => {
    const currentTenant = { status: 'trial', slug: 'dreux' }
    const updatedTenant = { id: 'tenant-1', status: 'active', slug: 'dreux' }

    const singleCurrent = vi.fn().mockResolvedValue({ data: currentTenant, error: null })
    const eqCurrent     = vi.fn().mockReturnValue({ single: singleCurrent })
    const selectCurrent = vi.fn().mockReturnValue({ eq: eqCurrent })

    const singleUpdate  = vi.fn().mockResolvedValue({ data: updatedTenant, error: null })
    const eqUpdate      = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: singleUpdate }) })
    const update        = vi.fn().mockReturnValue({ eq: eqUpdate })

    let callCount = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => {
      callCount++
      return (callCount === 1
        ? { select: selectCurrent }
        : { update }) as any
    })

    const res = await request(makeApp())
      .patch('/api/tenant/tenant-1/status')
      .send({ status: 'active' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'active' })
  })
})
