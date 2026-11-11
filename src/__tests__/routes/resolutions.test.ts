import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import { errorHandler } from '../../middleware/errorHandler.js'

/** Le jeton d'un vrai compte par défaut ; la session anonyme a son test. */
let anonymousSession = false

vi.mock('../../middleware/auth.js', () => ({
  verifyToken: (req: Request, _res: Response, next: NextFunction) => {
    req.userId = 'resident-1'
    req.isAnonymousUser = anonymousSession
    next()
  },
  verifyTokenOptional: (req: Request, _res: Response, next: NextFunction) => {
    req.userId = 'resident-1'
    next()
  },
}))

vi.mock('../../middleware/rateLimits.js', () => ({
  voteLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  voteReadLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

vi.mock('../../lib/photoUpload.js', () => ({
  uploadPhoto: vi.fn().mockResolvedValue('https://photos/claim.jpg'),
}))

vi.mock('../../services/resolutionService.js', () => ({
  claimResolution: vi.fn(),
  readResolution: vi.fn(),
}))

import { claimResolution, readResolution } from '../../services/resolutionService.js'
import { uploadPhoto } from '../../lib/photoUpload.js'
import resolutionsRouter from '../../routes/resolutions.js'

/**
 * La porte d'entrée des constats d'habitants.
 *
 * Ce que ces tests gardent est la **validation**, pas la règle métier : un
 * corps `multipart/form-data` ne transporte que des chaînes, et c'est là que
 * la vérification de position se laisse contourner le plus facilement.
 */

const app = () => {
  const instance = express()
  instance.use('/api/reports', resolutionsRouter)
  instance.use(errorHandler)
  return instance
}

const STATE = {
  status: 'en_attente',
  resolution_source: null,
  repaired_count: 1,
  still_there_count: 0,
  mine: 'repaired',
}

beforeEach(() => {
  anonymousSession = false
  vi.clearAllMocks()
  vi.mocked(claimResolution).mockResolvedValue(STATE as never)
  vi.mocked(readResolution).mockResolvedValue(STATE as never)
})

describe('POST /api/reports/:id/resolution', () => {
  it('records a repair backed by a photo and a position', async () => {
    const res = await request(app())
      .post('/api/reports/report-1/resolution')
      .field('kind', 'repaired')
      .field('lat', '48.7322')
      .field('lng', '1.3664')
      .attach('photo', Buffer.from('fake-jpeg'), { filename: 'repair.jpg', contentType: 'image/jpeg' })

    expect(res.status).toBe(200)
    expect(uploadPhoto).toHaveBeenCalled()
    expect(claimResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: 'report-1',
        userId: 'resident-1',
        kind: 'repaired',
        lat: 48.7322,
        lng: 1.3664,
        photoUrl: 'https://photos/claim.jpg',
      })
    )
  })

  /**
   * Le piège du formulaire multipart.
   *
   * `lat` y arrive en chaîne. Un « ici » non numérique devenait `NaN`, et
   * `NaN > 150` est **faux** : le constat passait la vérification de distance
   * et fermait un signalement depuis n'importe où. C'est la faille la plus
   * discrète de tout ce dispositif, et elle se referme ici.
   */
  it('refuses a position that is not a number', async () => {
    for (const lat of ['ici', '', 'NaN', 'null']) {
      const res = await request(app())
        .post('/api/reports/report-1/resolution')
        .field('kind', 'repaired')
        .field('lat', lat)
        .field('lng', '1.3664')
        .attach('photo', Buffer.from('x'), { filename: 'a.jpg', contentType: 'image/jpeg' })

      expect(res.status).toBe(400)
    }

    expect(claimResolution).not.toHaveBeenCalled()
  })

  it('refuses a missing position', async () => {
    const res = await request(app())
      .post('/api/reports/report-1/resolution')
      .field('kind', 'repaired')
      .attach('photo', Buffer.from('x'), { filename: 'a.jpg', contentType: 'image/jpeg' })

    expect(res.status).toBe(400)
    expect(claimResolution).not.toHaveBeenCalled()
  })

  /** Fermer un signalement se prouve. */
  it('refuses a repair with no photo', async () => {
    const res = await request(app())
      .post('/api/reports/report-1/resolution')
      .field('kind', 'repaired')
      .field('lat', '48.7322')
      .field('lng', '1.3664')

    expect(res.status).toBe(400)
    expect(claimResolution).not.toHaveBeenCalled()
  })

  /** Rouvrir ne retire rien à personne : la photo n'y est pas exigée. */
  it('accepts a contest without a photo', async () => {
    const res = await request(app())
      .post('/api/reports/report-1/resolution')
      .field('kind', 'still_there')
      .field('lat', '48.7322')
      .field('lng', '1.3664')

    expect(res.status).toBe(200)
    expect(claimResolution).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'still_there', photoUrl: null })
    )
  })

  it('refuses a kind it does not know', async () => {
    const res = await request(app())
      .post('/api/reports/report-1/resolution')
      .field('kind', 'resolu')
      .field('lat', '48.7322')
      .field('lng', '1.3664')

    expect(res.status).toBe(400)
    expect(claimResolution).not.toHaveBeenCalled()
  })

  /** Un constat sans photo n'envoie rien au stockage. */
  it('uploads nothing when there is no file', async () => {
    await request(app())
      .post('/api/reports/report-1/resolution')
      .field('kind', 'still_there')
      .field('lat', '48.7322')
      .field('lng', '1.3664')

    expect(uploadPhoto).not.toHaveBeenCalled()
  })
})

/**
 * L'application se connecte anonymement pour que ses requêtes portent un jeton
 * vérifiable. C'est une preuve d'origine, pas une identité : ces sessions
 * s'obtiennent à volonté, et la règle du second constat suppose deux
 * personnes. Sans ce refus, deux sessions suffisaient à fermer seul le
 * signalement de n'importe qui.
 */
describe('an anonymous session', () => {
  it('cannot record a claim', async () => {
    anonymousSession = true

    const res = await request(app())
      .post('/api/reports/report-1/resolution')
      .field('kind', 'still_there')
      .field('lat', '48.7322')
      .field('lng', '1.3664')

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('account_required')
    expect(claimResolution).not.toHaveBeenCalled()
  })

  it('is refused before any photo is uploaded', async () => {
    anonymousSession = true

    await request(app())
      .post('/api/reports/report-1/resolution')
      .field('kind', 'repaired')
      .field('lat', '48.7322')
      .field('lng', '1.3664')
      .attach('photo', Buffer.from('x'), { filename: 'a.jpg', contentType: 'image/jpeg' })

    expect(uploadPhoto).not.toHaveBeenCalled()
  })
})

describe('GET /api/reports/:id/resolution', () => {
  it('reads the state, which anyone may see', async () => {
    const res = await request(app()).get('/api/reports/report-1/resolution')

    expect(res.status).toBe(200)
    expect(res.body.repaired_count).toBe(1)
  })
})
