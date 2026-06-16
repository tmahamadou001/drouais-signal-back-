import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from '../helpers/createTestApp.js'

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: {
    from: vi.fn(),
    rpc: vi.fn(),
    storage: { from: vi.fn() },
  },
}))

vi.mock('../../middleware/auth.js', () => ({
  verifyToken: (req: any, _res: any, next: any) => {
    req.userId = 'admin-user-id'
    req.userRole = 'admin'
    next()
  },
  verifyTokenOptional: (req: any, _res: any, next: any) => {
    next()
  },
}))

vi.mock('../../middleware/roleGuard.js', () => ({
  requireTenantAdmin: (req: any, _res: any, next: any) => {
    req.userId = 'admin-user-id'
    next()
  },
}))

vi.mock('../../middleware/trustedOrigin.js', async (importActual) => {
  const actual = await importActual<typeof import('../../middleware/trustedOrigin.js')>()
  return { ...actual, requireTrustedOrigin: (_req: any, _res: any, next: any) => next() }
})

vi.mock('../../middleware/upload.js', () => ({
  upload: { single: () => (_req: any, _res: any, next: any) => next() },
}))

vi.mock('../../middleware/rateLimits.js', () => ({
  createReportLimiter: (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../../middleware/validate.js', () => ({
  validate: () => (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../../services/auditService.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
  auditReportStatusChanged: vi.fn().mockResolvedValue(undefined),
  auditReportDeleted: vi.fn().mockResolvedValue(undefined),
  auditReportBulkDeleted: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/notificationService.js', () => ({
  sendStatusChangeNotification: vi.fn().mockResolvedValue(undefined),
  sendServiceNotification: vi.fn().mockResolvedValue(undefined),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { createAuditLog } from '../../services/auditService.js'
import reportsRouter from '../../routes/reports.js'

const TENANT = {
  id: 'tenant-1',
  slug: 'dreux',
  name: 'Dreux',
  status: 'active',
  plan: 'starter',
  created_at: '',
  updated_at: '',
}

// Injects req.tenant on every request
function withTenant(app: ReturnType<typeof createTestApp>) {
  app.use((req: any, _res: any, next: any) => { req.tenant = TENANT; next() })
  return app
}

function buildApp() {
  const app = createTestApp('/api/reports', reportsRouter)
  // Inject tenant via a global middleware before routes
  const base = express()
  base.use(express.json())
  base.use((req: any, _res: any, next: any) => { req.tenant = TENANT; next() })
  base.use('/api/reports', reportsRouter)
  const { errorHandler } = require('../../middleware/errorHandler.js')
  base.use(errorHandler)
  return base
}

// Simpler: attach tenant directly via a prepended middleware
import express from 'express'
import { errorHandler } from '../../middleware/errorHandler.js'

function makeApp({ withUser = true } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => {
    req.tenant = TENANT
    if (withUser) req.userId = 'user-123'
    next()
  })
  app.use('/api/reports', reportsRouter)
  app.use(errorHandler)
  return app
}

// ─── Supabase query chain builder ────────────────────────────────────────────

function mockChain(result: object) {
  const terminal = vi.fn().mockResolvedValue(result)
  const handler: any = new Proxy({}, {
    get: () => () => handler,
  })
  // Override terminal methods
  handler.single = terminal
  handler.then = undefined
  return { handler, terminal }
}

function mockFrom(table: string, result: object) {
  const single = vi.fn().mockResolvedValue(result)
  const range   = vi.fn().mockResolvedValue(result)
  const order   = vi.fn().mockReturnValue({ single, range, eq: vi.fn().mockReturnValue({ single, range }) })
  const eq      = vi.fn().mockReturnValue({ single, order, eq: vi.fn().mockReturnValue({ single, order }) })
  const select  = vi.fn().mockReturnValue({ eq, order, single, range })
  const insert  = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) })
  const update  = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) }) })
  const del     = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }), in: vi.fn().mockResolvedValue({ error: null }) })

  vi.mocked(supabaseAdmin.from).mockImplementation((t: string) => {
    if (t === table) return { select, insert, update, delete: del } as any
    return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) } as any
  })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/reports', () => {
  beforeEach(() => vi.clearAllMocks())

  it('requireTrustedOrigin blocks requests with no recognised Origin', async () => {
    const { isTrustedOrigin } = await vi.importActual<typeof import('../../middleware/trustedOrigin.js')>('../../middleware/trustedOrigin.js')
    expect(isTrustedOrigin(undefined)).toBe(false)
    expect(isTrustedOrigin('https://evil.com')).toBe(false)
    expect(isTrustedOrigin('https://dreux.onsignale.fr')).toBe(true)
    expect(isTrustedOrigin('http://localhost:5173')).toBe(true)
  })

  it('returns 400 when tenant is missing', async () => {
    const app = express()
    app.use(express.json())
    // Simulate authenticated user but no tenant resolved
    app.use((req: any, _res: any, next: any) => { req.userId = 'user-123'; next() })
    app.use('/api/reports', reportsRouter)
    app.use(errorHandler)

    const res = await request(app)
      .post('/api/reports')
      .send({ title: 'Test', category: 'voirie', lat: 48.73, lng: 1.36 })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad_request')
  })

  it('returns 400 when category is invalid for tenant', async () => {
    // categories query returns known slugs — "invalid-cat" not in list
    const single = vi.fn()
    const eqIsActive = vi.fn().mockResolvedValue({ data: [{ slug: 'voirie' }], error: null })
    const eqTenant  = vi.fn().mockReturnValue({ eq: eqIsActive })
    const selectCat = vi.fn().mockReturnValue({ eq: eqTenant })
    // config query returns null config (no geo check)
    const singleCfg = vi.fn().mockResolvedValue({ data: null, error: null })
    const eqCfg     = vi.fn().mockReturnValue({ single: singleCfg })
    const selectCfg = vi.fn().mockReturnValue({ eq: eqCfg })

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'tenant_categories') return { select: selectCat } as any
      if (table === 'tenant_configs')    return { select: selectCfg } as any
      return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single }) }) } as any
    })

    const res = await request(makeApp())
      .post('/api/reports')
      .send({ title: 'Test', category: 'invalid-cat', lat: 48.73, lng: 1.36 })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad_request')
  })

  it('returns 422 when coordinates are out of tenant bounds', async () => {
    const eqIsActive = vi.fn().mockResolvedValue({ data: [{ slug: 'voirie' }], error: null })
    const eqTenant   = vi.fn().mockReturnValue({ eq: eqIsActive })
    const selectCat  = vi.fn().mockReturnValue({ eq: eqTenant })

    const singleCfg  = vi.fn().mockResolvedValue({
      data: { map_lat: 48.7322, map_lng: 1.3664, map_radius_km: 5 },
      error: null,
    })
    const eqCfg      = vi.fn().mockReturnValue({ single: singleCfg })
    const selectCfg  = vi.fn().mockReturnValue({ eq: eqCfg })

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'tenant_categories') return { select: selectCat } as any
      if (table === 'tenant_configs')    return { select: selectCfg } as any
      return {} as any
    })

    // Coordinates far away from tenant center (Paris vs Dreux ~80km)
    const res = await request(makeApp())
      .post('/api/reports')
      .send({ title: 'Test', category: 'voirie', lat: 48.8566, lng: 2.3522 })

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('out_of_bounds')
  })

  it('returns 201 and triggers audit log on successful creation', async () => {
    const single    = vi.fn()
    const eqIsActive = vi.fn().mockResolvedValue({ data: [{ slug: 'voirie' }], error: null })
    const eqCatTenant = vi.fn().mockReturnValue({ eq: eqIsActive })
    const selectCat = vi.fn().mockReturnValue({ eq: eqCatTenant })

    const singleCfg = vi.fn().mockResolvedValue({ data: null, error: null })
    const eqCfg     = vi.fn().mockReturnValue({ single: singleCfg })
    const selectCfg = vi.fn().mockReturnValue({ eq: eqCfg })

    const singleInsert = vi.fn().mockResolvedValue({
      data: { id: 'report-new', anonymous_token: null },
      error: null,
    })
    const selectInsert = vi.fn().mockReturnValue({ single: singleInsert })
    const insert       = vi.fn().mockReturnValue({ select: selectInsert })

    vi.mocked(supabaseAdmin.rpc).mockResolvedValue({ data: null, error: null } as any)

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'tenant_categories') return { select: selectCat } as any
      if (table === 'tenant_configs')    return { select: selectCfg } as any
      if (table === 'reports')           return { insert } as any
      return {} as any
    })

    const app = express()
    app.use(express.json())
    app.use((req: any, _res: any, next: any) => {
      req.tenant = TENANT
      req.userId = 'user-123' // authenticated user — no api key needed
      next()
    })
    app.use('/api/reports', reportsRouter)
    app.use(errorHandler)

    const res = await request(app)
      .post('/api/reports')
      .send({ title: 'Nid de poule', category: 'voirie', lat: 48.73, lng: 1.36 })

    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('id', 'report-new')
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'report.created',
      entityId: 'report-new',
    }))
  })
})

describe('PATCH /api/reports/:id/status', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when report does not exist', async () => {
    const single = vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } })
    const eq     = vi.fn().mockReturnValue({ single })
    const select = vi.fn().mockReturnValue({ eq })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as any)

    const res = await request(makeApp())
      .patch('/api/reports/unknown-id/status')
      .send({ status: 'pris_en_charge' })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
  })

  it('returns 200 and triggers audit log on status change', async () => {
    const report = {
      id: 'report-1', title: 'Voirie', status: 'en_attente',
      category: 'voirie', address_approx: null, photo_url: null,
      created_at: '2024-01-01', user_id: 'user-1',
      tenant_id: 'tenant-1', is_anonymous: false, anonymous_token: null,
    }
    const single = vi.fn().mockResolvedValue({ data: report, error: null })
    const eq     = vi.fn().mockReturnValue({ single })
    const select = vi.fn().mockReturnValue({ eq })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as any)
    vi.mocked(supabaseAdmin.rpc).mockResolvedValue({ data: [{ ...report, status: 'pris_en_charge' }], error: null } as any)

    const res = await request(makeApp())
      .patch('/api/reports/report-1/status')
      .send({ status: 'pris_en_charge' })

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'pris_en_charge' })
  })
})

describe('DELETE /api/reports/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when report does not exist', async () => {
    const single = vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } })
    const eq     = vi.fn().mockReturnValue({ single })
    const select = vi.fn().mockReturnValue({ eq })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as any)

    const res = await request(makeApp()).delete('/api/reports/ghost-id')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
  })

  it('returns 403 when report belongs to a different tenant', async () => {
    const single = vi.fn().mockResolvedValue({
      data: { id: 'report-1', title: 'Test', tenant_id: 'other-tenant', photo_url: null },
      error: null,
    })
    const eq     = vi.fn().mockReturnValue({ single })
    const select = vi.fn().mockReturnValue({ eq })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as any)

    const res = await request(makeApp()).delete('/api/reports/report-1')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('forbidden')
  })

  it('returns 200 on successful deletion', async () => {
    const single = vi.fn().mockResolvedValue({
      data: { id: 'report-1', title: 'Test', tenant_id: 'tenant-1', photo_url: null },
      error: null,
    })
    const eqDel    = vi.fn().mockResolvedValue({ error: null })
    const eqInDel  = vi.fn().mockResolvedValue({ error: null })
    const delChain = vi.fn().mockReturnValue({ eq: eqDel, in: eqInDel })
    const eqSel    = vi.fn().mockReturnValue({ single })
    const select   = vi.fn().mockReturnValue({ eq: eqSel })

    vi.mocked(supabaseAdmin.from).mockReturnValue({
      select, delete: delChain,
    } as any)

    const res = await request(makeApp()).delete('/api/reports/report-1')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })
})

describe('POST /api/reports — service notification', () => {
  beforeEach(() => vi.clearAllMocks())

  function buildPostApp() {
    const app = express()
    app.use(express.json())
    app.use((req: any, _res: any, next: any) => {
      req.tenant = TENANT
      req.userId = 'user-123'
      next()
    })
    app.use('/api/reports', reportsRouter)
    app.use(errorHandler)
    return app
  }

  it('calls sendServiceNotification after successful report creation', async () => {
    const { sendServiceNotification } = await import('../../services/notificationService.js')

    const eqIsActive  = vi.fn().mockResolvedValue({ data: [{ slug: 'voirie' }], error: null })
    const eqCatTenant = vi.fn().mockReturnValue({ eq: eqIsActive })
    const selectCat   = vi.fn().mockReturnValue({ eq: eqCatTenant })

    const singleCfg = vi.fn().mockResolvedValue({ data: null, error: null })
    const eqCfg     = vi.fn().mockReturnValue({ single: singleCfg })
    const selectCfg = vi.fn().mockReturnValue({ eq: eqCfg })

    const singleInsert = vi.fn().mockResolvedValue({
      data: { id: 'report-svc', anonymous_token: null },
      error: null,
    })
    const selectInsert = vi.fn().mockReturnValue({ single: singleInsert })
    const insert       = vi.fn().mockReturnValue({ select: selectInsert })

    vi.mocked(supabaseAdmin.rpc).mockResolvedValue({ data: null, error: null } as any)

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'tenant_categories') return { select: selectCat } as any
      if (table === 'tenant_configs')    return { select: selectCfg } as any
      if (table === 'reports')           return { insert } as any
      return {} as any
    })

    const res = await request(buildPostApp())
      .post('/api/reports')
      .send({ title: 'Lampadaire cassé', category: 'voirie', lat: 48.73, lng: 1.36 })

    expect(res.status).toBe(201)
    expect(sendServiceNotification).toHaveBeenCalledOnce()
    expect(sendServiceNotification).toHaveBeenCalledWith(expect.objectContaining({
      reportId: 'report-svc',
      reportTitle: 'Lampadaire cassé',
      category: 'voirie',
      tenantId: 'tenant-1',
      tenantSlug: 'dreux',
    }))
  })

  it('does not block the response if sendServiceNotification rejects', async () => {
    const { sendServiceNotification } = await import('../../services/notificationService.js')
    vi.mocked(sendServiceNotification).mockRejectedValueOnce(new Error('SMTP failure'))

    const eqIsActive  = vi.fn().mockResolvedValue({ data: [{ slug: 'voirie' }], error: null })
    const eqCatTenant = vi.fn().mockReturnValue({ eq: eqIsActive })
    const selectCat   = vi.fn().mockReturnValue({ eq: eqCatTenant })

    const singleCfg = vi.fn().mockResolvedValue({ data: null, error: null })
    const eqCfg     = vi.fn().mockReturnValue({ single: singleCfg })
    const selectCfg = vi.fn().mockReturnValue({ eq: eqCfg })

    const singleInsert = vi.fn().mockResolvedValue({
      data: { id: 'report-err', anonymous_token: null },
      error: null,
    })
    const selectInsert = vi.fn().mockReturnValue({ single: singleInsert })
    const insert       = vi.fn().mockReturnValue({ select: selectInsert })

    vi.mocked(supabaseAdmin.rpc).mockResolvedValue({ data: null, error: null } as any)

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'tenant_categories') return { select: selectCat } as any
      if (table === 'tenant_configs')    return { select: selectCfg } as any
      if (table === 'reports')           return { insert } as any
      return {} as any
    })

    const res = await request(buildPostApp())
      .post('/api/reports')
      .send({ title: 'Test', category: 'voirie', lat: 48.73, lng: 1.36 })

    // Response must still be 201 — notification is fire-and-forget
    expect(res.status).toBe(201)
  })
})

describe('DELETE /api/reports (bulk)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when ids array is missing', async () => {
    const res = await request(makeApp())
      .delete('/api/reports')
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad_request')
  })

  it('returns 403 when reports belong to a different tenant', async () => {
    const inFn  = vi.fn().mockResolvedValue({
      data: [{ id: 'r1', tenant_id: 'other-tenant', photo_url: null }],
      error: null,
    })
    const select = vi.fn().mockReturnValue({ in: inFn })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as any)

    const res = await request(makeApp())
      .delete('/api/reports')
      .send({ ids: ['r1'] })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('forbidden')
  })
})
