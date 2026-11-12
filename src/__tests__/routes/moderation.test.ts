import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import { errorHandler } from '../../middleware/errorHandler.js'

let superAdmin = true

vi.mock('../../middleware/auth.js', () => ({
  verifyToken: (req: Request, _res: Response, next: NextFunction) => {
    req.userId = 'super-admin-id'
    next()
  },
}))

vi.mock('../../middleware/roleGuard.js', () => ({
  // La modération travaille en travers des communes : son garde ne dépend
  // donc pas de `req.tenant` (voir `requirePlatformAdmin`).
  requirePlatformAdmin: (_req: Request, res: Response, next: NextFunction) => {
    if (!superAdmin) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    next()
  },
}))

vi.mock('../../services/auditService.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/moderationService.js', () => ({
  listModerationQueue: vi.fn(),
  retractReport: vi.fn(),
  restoreReport: vi.fn(),
  removeReportPhoto: vi.fn(),
}))

import { createAuditLog } from '../../services/auditService.js'
import {
  listModerationQueue,
  retractReport,
  restoreReport,
  removeReportPhoto,
} from '../../services/moderationService.js'
import moderationRouter from '../../routes/moderation.js'

/**
 * La porte de la modération.
 *
 * Deux choses à tenir : elle n'est ouverte qu'au super-administrateur — c'est
 * la seule personne qui répond de ce qui est publié dans une commune sans
 * mairie — et **aucun geste ne part sans motif**, parce qu'un retrait sans
 * motif ne peut être ni expliqué ni contesté six mois plus tard.
 */

const app = () => {
  const instance = express()
  instance.use(express.json())
  instance.use('/api/moderation', moderationRouter)
  instance.use(errorHandler)
  return instance
}

const OUTCOME = { title: 'Nid-de-poule', tenantId: 'tenant-1', tenantSlug: 'senonches-28373' }

beforeEach(() => {
  superAdmin = true
  vi.clearAllMocks()
  vi.mocked(listModerationQueue).mockResolvedValue({ data: [], total: 0 })
  vi.mocked(retractReport).mockResolvedValue(OUTCOME)
  vi.mocked(restoreReport).mockResolvedValue(OUTCOME)
  vi.mocked(removeReportPhoto).mockResolvedValue(OUTCOME)
})

describe('who may moderate', () => {
  it('refuses anyone but a super admin', async () => {
    superAdmin = false

    const list = await request(app()).get('/api/moderation/reports')
    const retract = await request(app())
      .post('/api/moderation/reports/report-1/retract')
      .send({ reason: 'Plaque visible' })

    expect(list.status).toBe(403)
    expect(retract.status).toBe(403)
    expect(retractReport).not.toHaveBeenCalled()
  })
})

describe('the queue', () => {
  it('pages, and caps how much can be asked for at once', async () => {
    await request(app()).get('/api/moderation/reports?limit=5000&page=3')

    expect(listModerationQueue).toHaveBeenCalledWith({ limit: 100, page: 3 })
  })

  it('falls back to sane values for nonsense paging', async () => {
    await request(app()).get('/api/moderation/reports?limit=abc&page=-2')

    expect(listModerationQueue).toHaveBeenCalledWith({ limit: 30, page: 1 })
  })
})

describe('every gesture carries a reason', () => {
  const gestures = [
    { path: 'retract', spy: retractReport },
    { path: 'restore', spy: restoreReport },
    { path: 'photo', spy: removeReportPhoto },
  ]

  for (const gesture of gestures) {
    it(`refuses to ${gesture.path} without one`, async () => {
      const res = await request(app()).post(`/api/moderation/reports/report-1/${gesture.path}`).send({})

      expect(res.status).toBe(400)
      expect(gesture.spy).not.toHaveBeenCalled()
    })

    it(`refuses to ${gesture.path} on a reason that says nothing`, async () => {
      const res = await request(app())
        .post(`/api/moderation/reports/report-1/${gesture.path}`)
        .send({ reason: ' ' })

      expect(res.status).toBe(400)
      expect(gesture.spy).not.toHaveBeenCalled()
    })

    it(`writes the ${gesture.path} down, with its reason`, async () => {
      const res = await request(app())
        .post(`/api/moderation/reports/report-1/${gesture.path}`)
        .send({ reason: 'Plaque d’immatriculation lisible' })

      expect(res.status).toBe(200)
      expect(gesture.spy).toHaveBeenCalledWith('report-1')
      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: 'report-1',
          tenantId: 'tenant-1',
          metadata: expect.objectContaining({ reason: 'Plaque d’immatriculation lisible' }),
        })
      )
    })
  }

  it('names each gesture distinctly in the trail', async () => {
    for (const gesture of gestures) {
      await request(app())
        .post(`/api/moderation/reports/report-1/${gesture.path}`)
        .send({ reason: 'Motif' })
    }

    const actions = vi.mocked(createAuditLog).mock.calls.map((call) => call[0].action)
    expect(actions).toEqual(['report.retracted', 'report.restored', 'report.photo_removed'])
  })

  /** Un motif n'est pas un commentaire : on en garde de quoi expliquer, pas un roman. */
  it('truncates an overlong reason rather than refusing it', async () => {
    await request(app())
      .post('/api/moderation/reports/report-1/retract')
      .send({ reason: 'x'.repeat(2000) })

    const logged = vi.mocked(createAuditLog).mock.calls[0][0].metadata as { reason: string }
    expect(logged.reason).toHaveLength(500)
  })
})
