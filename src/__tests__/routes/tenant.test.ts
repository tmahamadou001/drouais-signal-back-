import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { errorHandler } from '../../middleware/errorHandler.js'

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: () => Promise.resolve({ id: 'email-id' }) }
  },
}))

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: {
    from: vi.fn(),
    auth: {
      admin: {
        getUserById: vi.fn(),
        createUser: vi.fn(),
        listUsers: vi.fn(),
        generateLink: vi.fn(),
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

  it('persists service_name and service_emails in upsert payload', async () => {
    const upsertResult = [{
      id: 'cat-1',
      slug: 'voirie',
      label: 'Voirie',
      service_name: 'Service Voirie',
      service_emails: ['voirie@dreux.fr', 'technique@dreux.fr'],
    }]
    const select = vi.fn().mockResolvedValue({ data: upsertResult, error: null })
    const upsert = vi.fn().mockReturnValue({ select })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ upsert } as any)

    const res = await request(makeApp())
      .put('/api/tenant/categories')
      .send({
        categories: [{
          slug:          'voirie',
          label:         'Voirie',
          icon:          '🛣️',
          color:         '#EF4444',
          serviceName:   'Service Voirie',
          serviceEmails: ['voirie@dreux.fr', 'technique@dreux.fr'],
        }],
      })

    expect(res.status).toBe(200)

    // Check that the upsert received the service fields
    expect(upsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          service_name:   'Service Voirie',
          service_emails: ['voirie@dreux.fr', 'technique@dreux.fr'],
        }),
      ]),
      expect.anything()
    )
  })

  it('upserts with empty service_emails array when not provided', async () => {
    const upsertResult = [{ id: 'cat-1', slug: 'voirie', label: 'Voirie', service_emails: [] }]
    const select = vi.fn().mockResolvedValue({ data: upsertResult, error: null })
    const upsert = vi.fn().mockReturnValue({ select })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ upsert } as any)

    const res = await request(makeApp())
      .put('/api/tenant/categories')
      .send({ categories: [{ slug: 'voirie', label: 'Voirie', icon: '🛣️', color: '#EF4444' }] })

    expect(res.status).toBe(200)

    // service_emails should default to empty array
    expect(upsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ service_emails: [] }),
      ]),
      expect.anything()
    )
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

  it('returns 201 on successful invite (new user)', async () => {
    vi.mocked(supabaseAdmin.auth.admin.generateLink).mockResolvedValue({
      data: {
        user: { id: 'new-user-id', email: 'agent@dreux.fr', email_confirmed_at: null } as any,
        properties: { action_link: 'https://supabase.co/invite?token=abc' } as any,
      },
      error: null,
    })

    // from('tenant_configs').select().eq().single() — city_name
    const configSingle = vi.fn().mockResolvedValue({ data: { city_name: 'Dreux' }, error: null })
    const configEq     = vi.fn().mockReturnValue({ single: configSingle })
    const configSelect = vi.fn().mockReturnValue({ eq: configEq })

    // from('tenant_users').upsert().select().single()
    const upsertSingle = vi.fn().mockResolvedValue({ data: { id: 'tu-1', user_id: 'new-user-id', role: 'agent' }, error: null })
    const upsertSelect = vi.fn().mockReturnValue({ single: upsertSingle })
    const upsert       = vi.fn().mockReturnValue({ select: upsertSelect })

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'tenant_configs') return { select: configSelect } as any
      if (table === 'tenant_users')   return { upsert } as any
      return {} as any
    })

    const res = await request(makeApp())
      .post('/api/tenant/users/invite')
      .send({ email: 'agent@dreux.fr', role: 'agent' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ role: 'agent' })
    expect(supabaseAdmin.auth.admin.generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invite', email: 'agent@dreux.fr' })
    )
  })

  it('returns 201 and skips password link for existing confirmed user', async () => {
    vi.mocked(supabaseAdmin.auth.admin.generateLink).mockResolvedValue({
      data: {
        user: { id: 'existing-user-id', email: 'citizen@dreux.fr', email_confirmed_at: '2024-01-01T00:00:00Z' } as any,
        properties: { action_link: 'https://supabase.co/invite?token=abc' } as any,
      },
      error: null,
    })

    const configSingle = vi.fn().mockResolvedValue({ data: { city_name: 'Dreux' }, error: null })
    const configEq     = vi.fn().mockReturnValue({ single: configSingle })
    const configSelect = vi.fn().mockReturnValue({ eq: configEq })

    const upsertSingle = vi.fn().mockResolvedValue({ data: { id: 'tu-2', user_id: 'existing-user-id', role: 'observer' }, error: null })
    const upsertSelect = vi.fn().mockReturnValue({ single: upsertSingle })
    const upsert       = vi.fn().mockReturnValue({ select: upsertSelect })

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'tenant_configs') return { select: configSelect } as any
      if (table === 'tenant_users')   return { upsert } as any
      return {} as any
    })

    const res = await request(makeApp())
      .post('/api/tenant/users/invite')
      .send({ email: 'citizen@dreux.fr', role: 'observer' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ role: 'observer' })
  })

  it('returns 500 when generateLink fails', async () => {
    vi.mocked(supabaseAdmin.auth.admin.generateLink).mockResolvedValue({
      data: { user: null, properties: null } as any,
      error: { message: 'Supabase error' } as any,
    })

    const configSingle = vi.fn().mockResolvedValue({ data: { city_name: 'Dreux' }, error: null })
    const configEq     = vi.fn().mockReturnValue({ single: configSingle })
    const configSelect = vi.fn().mockReturnValue({ eq: configEq })
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'tenant_configs') return { select: configSelect } as any
      return {} as any
    })

    const res = await request(makeApp())
      .post('/api/tenant/users/invite')
      .send({ email: 'agent@dreux.fr', role: 'agent' })

    expect(res.status).toBe(500)
  })
})

describe('POST /api/tenant/users/:userId/resend-invite', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when member is not in tenant_users', async () => {
    const single = vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } })
    const eq2    = vi.fn().mockReturnValue({ single })
    const eq1    = vi.fn().mockReturnValue({ eq: eq2 })
    const select = vi.fn().mockReturnValue({ eq: eq1 })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as any)

    const res = await request(makeApp())
      .post('/api/tenant/users/ghost-id/resend-invite')

    expect(res.status).toBe(404)
  })

  it('returns 200 and calls generateLink with type recovery', async () => {
    const memberSingle = vi.fn().mockResolvedValue({
      data: { user_id: 'user-abc', role: 'agent', first_name: 'Jean' },
      error: null,
    })
    const memberEq2 = vi.fn().mockReturnValue({ single: memberSingle })
    const memberEq1 = vi.fn().mockReturnValue({ eq: memberEq2 })
    const memberSel = vi.fn().mockReturnValue({ eq: memberEq1 })

    const configSingle = vi.fn().mockResolvedValue({ data: { city_name: 'Dreux' }, error: null })
    const configEq     = vi.fn().mockReturnValue({ single: configSingle })
    const configSel    = vi.fn().mockReturnValue({ eq: configEq })

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'tenant_users')   return { select: memberSel } as any
      if (table === 'tenant_configs') return { select: configSel } as any
      return {} as any
    })

    vi.mocked(supabaseAdmin.auth.admin.getUserById).mockResolvedValue({
      data: { user: { id: 'user-abc', email: 'jean@dreux.fr' } as any },
      error: null,
    })

    vi.mocked(supabaseAdmin.auth.admin.generateLink).mockResolvedValue({
      data: {
        user: { id: 'user-abc' } as any,
        properties: { action_link: 'https://supabase.co/recovery?token=xyz' } as any,
      },
      error: null,
    })

    const res = await request(makeApp())
      .post('/api/tenant/users/user-abc/resend-invite')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(supabaseAdmin.auth.admin.generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery', email: 'jean@dreux.fr' })
    )
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
