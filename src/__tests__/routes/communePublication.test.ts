import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import { errorHandler } from '../../middleware/errorHandler.js'

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: () => Promise.resolve({ id: 'email-id' }) }
  },
}))

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: {
    from: vi.fn(),
    auth: { admin: { getUserById: vi.fn(), createUser: vi.fn(), listUsers: vi.fn(), generateLink: vi.fn() } },
  },
}))

vi.mock('../../middleware/auth.js', () => ({
  verifyToken: (req: Request, _res: Response, next: NextFunction) => {
    req.userId = 'super-admin-id'
    next()
  },
}))

vi.mock('../../middleware/tenantResolver.js', () => ({
  requireTenant: (_req: Request, _res: Response, next: NextFunction) => next(),
  invalidateTenantCache: vi.fn(),
}))

vi.mock('../../middleware/roleGuard.js', () => ({
  requireTenantAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireSuperAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

vi.mock('../../lib/authHelpers.js', () => ({ getAuthEmailMap: vi.fn() }))
vi.mock('../../services/categoryService.js', () => ({
  resolveCategories: vi.fn(),
  resolveActiveCategories: vi.fn(),
}))
vi.mock('../../services/teamService.js', () => ({ listTeam: vi.fn(), countOtherAdmins: vi.fn() }))
vi.mock('../../services/inviteService.js', () => ({ provisionInvite: vi.fn() }))

vi.mock('../../services/communeLaunchService.js', () => ({
  launchCommune: vi.fn().mockResolvedValue(undefined),
  publishTenantHistory: vi.fn().mockResolvedValue(12),
  unpublishTenantHistory: vi.fn().mockResolvedValue(12),
}))

vi.mock('../../services/auditService.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
  auditUserCreated: vi.fn().mockResolvedValue(undefined),
  auditTenantCreated: vi.fn().mockResolvedValue(undefined),
  auditTenantStatusChanged: vi.fn().mockResolvedValue(undefined),
  auditCommunePublication: vi.fn().mockResolvedValue(undefined),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import {
  launchCommune,
  publishTenantHistory,
  unpublishTenantHistory,
} from '../../services/communeLaunchService.js'
import { auditCommunePublication } from '../../services/auditService.js'
import tenantRouter from '../../routes/tenant.js'

/**
 * Ouvrir et refermer une commune sans mairie.
 *
 * Le geste le plus lourd de conséquences du back-office : il rend visible de
 * tous ce qu'une commune avait reçu en silence. Ces tests tiennent la décision
 * prise avec la responsable produit — l'historique suit la publication, dans
 * les deux sens, et une commune qui s'en va retombe au **silence**.
 */

const TENANT_ID = 'tenant-1'

/** Monte `tenants` : le statut actuel, puis la ligne mise à jour. */
function mockTenant(currentStatus: string) {
  const writes: Record<string, unknown>[] = []

  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table !== 'tenants') return {}

    const chain: Record<string, unknown> = {}
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      single: () => Promise.resolve({ data: { status: currentStatus, slug: 'senonches-28373' }, error: null }),
      update: (values: Record<string, unknown>) => {
        writes.push(values)
        const after: Record<string, unknown> = {}
        Object.assign(after, {
          eq: () => after,
          select: () => after,
          single: () =>
            Promise.resolve({
              data: { id: TENANT_ID, slug: 'senonches-28373', name: 'Senonches', ...values },
              error: null,
            }),
        })
        return after
      },
    })
    return chain
  }) as never)

  return writes
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/tenant', tenantRouter)
  app.use(errorHandler)
  return app
}

const patch = (status: string) =>
  request(makeApp()).patch(`/api/tenant/${TENANT_ID}/status`).send({ status })

/** Les effets partent sans être attendus par la réponse HTTP. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => vi.clearAllMocks())

describe('PATCH /api/tenant/:id/status', () => {
  it('accepts the community status', async () => {
    mockTenant('prospect')

    const res = await patch('community')

    expect(res.status).toBe(200)
  })

  it('refuses a status it does not know', async () => {
    mockTenant('prospect')

    const res = await patch('citoyenne')

    expect(res.status).toBe(400)
  })

  it('records when the commune was opened to the public', async () => {
    const writes = mockTenant('prospect')

    await patch('community')

    expect(writes[0]).toHaveProperty('published_at')
  })

  /** Une date d'ouverture, pas un drapeau : refermer ne l'efface pas. */
  it('keeps that date when the commune is closed again', async () => {
    const writes = mockTenant('community')

    await patch('prospect')

    expect(writes[0]).not.toHaveProperty('published_at')
  })
})

describe('what happens to the backlog', () => {
  it('publishes it when a silent commune opens', async () => {
    mockTenant('prospect')

    await patch('community')
    await settle()

    expect(publishTenantHistory).toHaveBeenCalledWith(TENANT_ID)
    expect(unpublishTenantHistory).not.toHaveBeenCalled()
  })

  /**
   * La décision du produit : une commune partenaire qui s'en va retombe au
   * silence. Laisser son inventaire public ferait du non-renouvellement un
   * moyen de pression.
   */
  it('unpublishes it when a partner commune leaves', async () => {
    mockTenant('active')

    await patch('prospect')
    await settle()

    expect(unpublishTenantHistory).toHaveBeenCalledWith(TENANT_ID)
    expect(publishTenantHistory).not.toHaveBeenCalled()
  })

  it('unpublishes it when a commune is suspended', async () => {
    mockTenant('active')

    await patch('suspended')
    await settle()

    expect(unpublishTenantHistory).toHaveBeenCalledWith(TENANT_ID)
  })

  it('unpublishes it when an open commune is closed again', async () => {
    mockTenant('community')

    await patch('prospect')
    await settle()

    expect(unpublishTenantHistory).toHaveBeenCalledWith(TENANT_ID)
  })

  /** Les deux côtés publient déjà : rien à republier, rien à retirer. */
  it('touches nothing when a community commune signs', async () => {
    mockTenant('community')

    await patch('active')
    await settle()

    expect(unpublishTenantHistory).not.toHaveBeenCalled()
  })

  it('leaves a silent commune alone when it is suspended', async () => {
    mockTenant('prospect')

    await patch('suspended')
    await settle()

    expect(publishTenantHistory).not.toHaveBeenCalled()
    expect(unpublishTenantHistory).not.toHaveBeenCalled()
  })

  it('writes down how many reports changed visibility', async () => {
    mockTenant('prospect')

    await patch('community')
    await settle()

    expect(auditCommunePublication).toHaveBeenCalledWith(
      expect.objectContaining({ opened: true, affectedReports: 12, tenantId: TENANT_ID })
    )
  })

  it('names a closure as such in the audit trail', async () => {
    mockTenant('active')

    await patch('prospect')
    await settle()

    expect(auditCommunePublication).toHaveBeenCalledWith(
      expect.objectContaining({ opened: false })
    )
  })
})

describe('the launch e-mail', () => {
  it('goes out when a silent commune becomes a partner', async () => {
    mockTenant('prospect')

    await patch('active')
    await settle()

    expect(launchCommune).toHaveBeenCalled()
  })

  /**
   * Les habitants s'étaient inscrits pour être prévenus que leur mairie
   * rejoigne la plateforme — pas que la page s'ouvre. Une commune citoyenne
   * qui signe le déclenche donc aussi, et c'est ce cas qui manquait avant la
   * migration 040.
   */
  it('goes out when a community commune becomes a partner', async () => {
    mockTenant('community')

    await patch('active')
    await settle()

    expect(launchCommune).toHaveBeenCalled()
  })

  /** Ouvrir au public n'est pas un lancement : personne n'a rejoint quoi que ce soit. */
  it('does not go out when a commune is merely opened to the public', async () => {
    mockTenant('prospect')

    await patch('community')
    await settle()

    expect(launchCommune).not.toHaveBeenCalled()
  })

  it('does not go out twice between partner statuses', async () => {
    mockTenant('trial')

    await patch('active')
    await settle()

    expect(launchCommune).not.toHaveBeenCalled()
  })
})
