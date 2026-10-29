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
  // Traiter un signalement — statut, transmission — n'exige plus d'être
  // administrateur : c'est le travail quotidien d'un agent.
  requireAgent: (req: any, _res: any, next: any) => {
    req.userId = 'admin-user-id'
    next()
  },
  requireTeamMember: (req: any, _res: any, next: any) => {
    req.userId = 'admin-user-id'
    next()
  },
}))

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

vi.mock('../../services/prospectService.js', () => ({
  ensureProspectTenant: vi.fn(),
}))

vi.mock('../../services/geoRouting.js', () => ({
  isPlausiblePosition: vi.fn(),
  resolve: vi.fn(),
}))

vi.mock('../../services/categoryService.js', () => ({
  resolveCategories: vi.fn(),
}))

vi.mock('../../services/notificationService.js', () => ({
  sendStatusChangeNotification: vi.fn().mockResolvedValue(undefined),
  sendServiceNotification: vi.fn().mockResolvedValue(undefined),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { createAuditLog, auditReportStatusChanged } from '../../services/auditService.js'
import reportsRouter from '../../routes/reports.js'
import { resolve as resolveLocation, isPlausiblePosition } from '../../services/geoRouting.js'
import { ensureProspectTenant } from '../../services/prospectService.js'
import { resolveCategories } from '../../services/categoryService.js'

const TENANT = {
  id: 'tenant-1',
  slug: 'dreux',
  name: 'Dreux',
  status: 'active',
  plan: 'starter',
  created_at: '',
  updated_at: '',
}

const LA_LOUPE = { ...TENANT, id: 'tenant-2', slug: 'la-loupe', name: 'La Loupe' }

/**
 * Par défaut, la position tombe dans Dreux.
 *
 * `resolve` est simulée plutôt que le réseau : ce que ces tests vérifient est
 * la décision du routage, pas la disponibilité de la BAN — elle a sa propre
 * suite dans `services/geoRouting.test.ts`.
 */
function mockGeo(location: object | null = {
  inseeCode: '28134',
  communeName: 'Dreux',
  addressLabel: '1 Rue d\'Orfeuil 28100 Dreux',
  tenant: TENANT,
}) {
  vi.mocked(isPlausiblePosition).mockReturnValue(true)
  vi.mocked(resolveLocation).mockResolvedValue(location as never)
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
  beforeEach(() => { vi.clearAllMocks(); mockGeo() })

  /** Catégories + insert : le décor minimal d'une création réussie. */
  function mockCreation(
    insertResult = { data: { id: 'report-new', anonymous_token: null }, error: null },
    { disabled = [] as string[] } = {}
  ) {
    // La liste nationale, telle que la commune la voit : c'est elle qui décide
    // désormais de ce qui existe, la commune ne règle que ce qu'elle traite.
    vi.mocked(resolveCategories).mockResolvedValue(
      ['voirie', 'encombrants', 'autre'].map((slug, index) => ({
        slug,
        label: slug,
        description: '',
        icon: '📌',
        color: null,
        is_active: !disabled.includes(slug),
        sort_order: index,
        sla_hours: 168,
        service_name: null,
        service_emails: [],
        is_default: true,
      }))
    )

    const singleInsert = vi.fn().mockResolvedValue(insertResult)
    const insert = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: singleInsert }) })

    vi.mocked(supabaseAdmin.rpc).mockResolvedValue({ data: null, error: null } as never)
    vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
      if (table === 'reports') return { insert }
      return {}
    }) as never)

    return { insert }
  }

  it('ignores X-Tenant-Slug and routes the report by position', async () => {
    // L'application déclare Dreux ; la position tombe à La Loupe.
    mockGeo({ inseeCode: '28214', communeName: 'La Loupe', addressLabel: null, tenant: LA_LOUPE })
    const { insert } = mockCreation()

    const res = await request(makeApp())
      .post('/api/reports')
      .set('X-Tenant-Slug', 'dreux')
      .send({ title: 'Dépôt sauvage', category: 'voirie', lat: 48.475, lng: 1.013 })

    expect(res.status).toBe(201)
    // C'est l'invariant central de la v2 : le client ne choisit pas le tenant
    // dans lequel il écrit. Un repli sur l'en-tête serait une écriture chez le voisin.
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'tenant-2' }))
  })

  it('stores the INSEE code as proof of the routing', async () => {
    const { insert } = mockCreation()

    await request(makeApp())
      .post('/api/reports')
      .send({ title: 'Test', category: 'voirie', lat: 48.73, lng: 1.36 })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      insee_code: '28134',
      geo_resolved: true,
      // L'adresse de la BAN prime sur celle proposée par le client.
      address_approx: "1 Rue d'Orfeuil 28100 Dreux",
    }))
  })

  it('stores the accuracy and capture time when supplied', async () => {
    const { insert } = mockCreation()

    await request(makeApp())
      .post('/api/reports')
      .send({
        title: 'Test', category: 'voirie', lat: 48.73, lng: 1.36,
        position_accuracy: 8.5,
        position_captured_at: '2026-09-14T09:12:00.000Z',
      })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      position_accuracy: 8.5,
      position_captured_at: '2026-09-14T09:12:00.000Z',
    }))
  })

  it('rejects an implausible position before any geocoding call', async () => {
    vi.mocked(isPlausiblePosition).mockReturnValue(false)

    const res = await request(makeApp())
      .post('/api/reports')
      .send({ title: 'Test', category: 'voirie', lat: 0, lng: 0 })

    expect(res.status).toBe(400)
    expect(resolveLocation).not.toHaveBeenCalled()
  })

  it('files an uncovered commune into a prospect tenant, unpublished', async () => {
    const PROSPECT = { ...TENANT, id: 'tenant-prospect', slug: 'paris-75104', status: 'prospect' }
    mockGeo({ inseeCode: '75104', communeName: 'Paris', addressLabel: null, tenant: null })
    vi.mocked(ensureProspectTenant).mockResolvedValue(PROSPECT as never)
    const { insert } = mockCreation()

    const res = await request(makeApp())
      .post('/api/reports')
      .send({ title: 'Dépôt sauvage', category: 'voirie', lat: 48.857, lng: 2.295 })

    expect(res.status).toBe(201)
    expect(ensureProspectTenant).toHaveBeenCalledWith('75104', 'Paris')
    // Refuser ferait perdre la seule chose qui convaincra cette mairie ;
    // publier serait une démarche commerciale hostile. On accueille sans publier.
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: 'tenant-prospect',
      is_published: false,
    }))
  })

  it('still refuses to publish once the prospect tenant already exists', async () => {
    // Le deuxième habitant d'une commune non cliente : le tenant prospect a été
    // créé par le premier, donc `resolve` le trouve et le rend. La couverture
    // se déduisait alors de « un tenant existe » — et le signalement partait
    // publié, exposant l'inventaire des dégradations d'une mairie qui n'a rien
    // demandé. Elle se lit sur le statut.
    const PROSPECT = { ...TENANT, id: 'tenant-prospect', slug: 'paris-75104', status: 'prospect' }
    mockGeo({
      inseeCode: '75104',
      communeName: 'Paris',
      addressLabel: null,
      tenant: PROSPECT as never,
    })
    const { insert } = mockCreation()

    const res = await request(makeApp())
      .post('/api/reports')
      .send({ title: 'Dépôt sauvage', category: 'voirie', lat: 48.857, lng: 2.295 })

    expect(res.status).toBe(201)
    // Le tenant existe déjà : on ne doit pas en créer un second.
    expect(ensureProspectTenant).not.toHaveBeenCalled()
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: 'tenant-prospect',
      is_published: false,
    }))
  })

  it('publishes a report in a partner commune', async () => {
    const { insert } = mockCreation()

    await request(makeApp())
      .post('/api/reports')
      .send({ title: 'Test', category: 'voirie', lat: 48.73, lng: 1.36 })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ is_published: true }))
    expect(ensureProspectTenant).not.toHaveBeenCalled()
  })

  it('fails when the prospect tenant cannot be created', async () => {
    mockGeo({ inseeCode: '75104', communeName: 'Paris', addressLabel: null, tenant: null })
    vi.mocked(ensureProspectTenant).mockResolvedValue(null)

    const res = await request(makeApp())
      .post('/api/reports')
      .send({ title: 'Test', category: 'voirie', lat: 48.857, lng: 2.295 })

    expect(res.status).toBe(503)
    expect(res.body.error).toBe('tenant_unavailable')
  })

  it('fails closed when geocoding is down, without falling back to the header', async () => {
    mockGeo(null)

    const res = await request(makeApp())
      .post('/api/reports')
      .set('X-Tenant-Slug', 'dreux')
      .send({ title: 'Test', category: 'voirie', lat: 48.73, lng: 1.36 })

    // 503 et non 201 : un repli sur l'en-tête suffirait à contourner toute la
    // résolution serveur en envoyant une coordonnée irrésoluble.
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('geocoding_unavailable')
  })

  it('rejects a category absent from the national list', async () => {
    mockCreation()

    const res = await request(makeApp())
      .post('/api/reports')
      .send({ title: 'Test', category: 'cat_1757836291043', lat: 48.73, lng: 1.36 })

    // Un slug horodaté inventé par une commune ne désigne plus rien : la
    // taxonomie est nationale, la commune n'en définit plus le contenu.
    expect(res.status).toBe(400)
  })

  it('rejects a category the commune has disabled', async () => {
    mockCreation(undefined, { disabled: ['encombrants'] })

    const res = await request(makeApp())
      .post('/api/reports')
      .send({ title: 'Test', category: 'encombrants', lat: 48.73, lng: 1.36 })

    expect(res.status).toBe(400)
    expect(res.body.message).toContain('ne traite pas')
  })

  it('reads the categories of the resolved tenant, not the declared one', async () => {
    mockGeo({ inseeCode: '28214', communeName: 'La Loupe', addressLabel: null, tenant: LA_LOUPE })
    mockCreation()

    await request(makeApp())
      .post('/api/reports')
      .set('X-Tenant-Slug', 'dreux')
      .send({ title: 'Test', category: 'voirie', lat: 48.475, lng: 1.013 })

    expect(resolveCategories).toHaveBeenCalledWith('tenant-2')
  })


  it('returns 201 and triggers audit log on successful creation', async () => {
    vi.mocked(resolveCategories).mockResolvedValue([])
    const single    = vi.fn()
    const eqIsActive = vi.fn().mockResolvedValue({ data: [], error: null })
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
      if (table === 'categories') return {
        select: vi.fn().mockResolvedValue({ data: [{ slug: 'voirie' }], error: null }),
      } as any
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

  /**
   * Resolving tells the citizen it is done. Reopening would make that promise
   * something the commune can withdraw, and would let one report be counted
   * resolved more than once in the statistics shown to elected officials.
   */
  it('refuses to change the status of a resolved report', async () => {
    const report = {
      id: 'report-1', title: 'Voirie', status: 'resolu',
      category: 'voirie', address_approx: null, photo_url: null,
      created_at: '2024-01-01', user_id: 'user-1',
      tenant_id: 'tenant-1', is_anonymous: false, anonymous_token: null,
    }
    const single = vi.fn().mockResolvedValue({ data: report, error: null })
    const eq     = vi.fn().mockReturnValue({ single })
    const select = vi.fn().mockReturnValue({ eq })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as any)

    const res = await request(makeApp())
      .patch('/api/reports/report-1/status')
      .send({ status: 'pris_en_charge' })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('status_final')
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled()
  })

  /**
   * Going back is allowed everywhere else — clicking the wrong row had no
   * remedy — and the audit log has to say that this one was a correction
   * rather than a step forward.
   */
  it('marks a backwards change as a rollback in the audit log', async () => {
    const report = {
      id: 'report-1', title: 'Voirie', status: 'pris_en_charge',
      category: 'voirie', address_approx: null, photo_url: null,
      created_at: '2024-01-01', user_id: 'user-1',
      tenant_id: 'tenant-1', is_anonymous: false, anonymous_token: null,
    }
    const single = vi.fn().mockResolvedValue({ data: report, error: null })
    const eq     = vi.fn().mockReturnValue({ single })
    const select = vi.fn().mockReturnValue({ eq })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as any)
    vi.mocked(supabaseAdmin.rpc).mockResolvedValue({ data: [{ ...report, status: 'en_attente' }], error: null } as any)

    const res = await request(makeApp())
      .patch('/api/reports/report-1/status')
      .send({ status: 'en_attente' })

    expect(res.status).toBe(200)
    expect(auditReportStatusChanged).toHaveBeenCalledWith(
      expect.objectContaining({ oldStatus: 'pris_en_charge', newStatus: 'en_attente', rollback: true })
    )
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
  beforeEach(() => {
    vi.clearAllMocks()
    mockGeo()
    // Liste vide : la validation de catégorie n'est pas le sujet ici, et une
    // implémentation qui fuirait d'un test précédent rendrait ceux-ci opaques.
    vi.mocked(resolveCategories).mockResolvedValue([])
  })

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

    const eqIsActive  = vi.fn().mockResolvedValue({ data: [], error: null })
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
      if (table === 'categories') return {
        select: vi.fn().mockResolvedValue({ data: [{ slug: 'voirie' }], error: null }),
      } as any
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

    const eqIsActive  = vi.fn().mockResolvedValue({ data: [], error: null })
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
      if (table === 'categories') return {
        select: vi.fn().mockResolvedValue({ data: [{ slug: 'voirie' }], error: null }),
      } as any
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

/**
 * Reading what is yours, from wherever you stand.
 *
 * Three routes were crossed with `X-Tenant-Slug` — the commune the phone is in
 * *right now* — when they answer a question that has nothing to do with it. A
 * resident of Dreux visiting La Loupe saw "My reports" empty out: the pothole
 * outside their house had vanished, and they could no longer tell whether it
 * had been fixed.
 */
describe('personal reads cross commune borders', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists the caller’s reports whatever commune they are standing in', async () => {
    const eqUser = vi.fn().mockReturnValue({
      order: vi.fn().mockResolvedValue({ data: [{ id: 'r1', tenant_id: 'other-tenant' }], error: null }),
    })
    const select = vi.fn().mockReturnValue({ eq: eqUser })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select } as any)

    const res = await request(makeApp()).get('/api/reports/mine')

    expect(res.status).toBe(200)
    // Filtered on the author, and on nothing else.
    expect(eqUser).toHaveBeenCalledTimes(1)
    expect(eqUser).toHaveBeenCalledWith('user_id', expect.anything())
  })

  /**
   * This link travels in a follow-up email, so it is opened from anywhere — an
   * office, a train, another commune. The token is the proof, and it is worth
   * exactly one report.
   */
  it('opens a follow-up link without asking where the reader is', async () => {
    const chain: any = {
      select: () => chain,
      eq: vi.fn(function (this: unknown) { return chain }),
      single: async () => ({ data: { id: 'r1', reference: 'DRX-2026-00001' }, error: null }),
    }
    vi.mocked(supabaseAdmin.from).mockReturnValue(chain)

    const res = await request(makeApp()).get('/api/reports/anonymous/a-very-long-token')

    expect(res.status).toBe(200)
    // Only the token and the anonymous flag — never the tenant.
    expect(chain.eq.mock.calls.map((call: unknown[]) => call[0]))
      .toEqual(['anonymous_token', 'is_anonymous'])
  })
})

describe('GET /api/reports/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  function mockDetail(report: Record<string, unknown> | null) {
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'reports') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          single: async () => ({ data: report, error: report ? null : { message: 'not found' } }),
        }
        return chain
      }
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: async () => ({ data: [] }),
      }
      return chain
    })
  }

  it('serves a published report to anyone, from any commune', async () => {
    mockDetail({ id: 'r1', tenant_id: 'other-tenant', is_published: true, user_id: null })

    expect((await request(makeApp()).get('/api/reports/r1')).status).toBe(200)
  })

  /**
   * Prospect communes' reports are collected without the mairie asking for
   * anything, and publishing that inventory would be a hostile sales move. The
   * list and the map already dropped them; this route did not — the tenant
   * filter stood in for the protection, by accident, and it has just gone.
   */
  it('hides an unpublished report from a passer-by', async () => {
    mockDetail({ id: 'r1', tenant_id: 'prospect', is_published: false, user_id: 'someone-else' })

    const res = await request(makeApp()).get('/api/reports/r1')

    expect(res.status).toBe(404)
  })

  it('still serves an unpublished report to the author’s follow-up token', async () => {
    mockDetail({ id: 'r1', is_published: false, user_id: null, anonymous_token: 'the-token' })

    const res = await request(makeApp())
      .get('/api/reports/r1')
      .set('X-Report-Token', 'the-token')

    expect(res.status).toBe(200)
  })
})
