import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { errorHandler } from '../../middleware/errorHandler.js'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

vi.mock('../../middleware/auth.js', () => ({
  verifyToken: (req: any, _res: any, next: any) => {
    req.userId = 'citizen-1'
    next()
  },
}))

vi.mock('../../middleware/rateLimits.js', () => ({
  voteLimiter: (_req: any, _res: any, next: any) => next(),
  voteReadLimiter: (_req: any, _res: any, next: any) => next(),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import votesRouter, { distanceMeters } from '../../routes/votes.js'

/** Rue d'Orfeuil, Dreux — where the report sits in every test below. */
const REPORT = { id: 'report-1', status: 'en_attente', vote_count: 3, lat: 48.7322, lng: 1.3664 }

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => {
    req.tenant = { id: 'tenant-1', slug: 'dreux' }
    next()
  })
  app.use('/api/reports', votesRouter)
  app.use(errorHandler)
  return app
}

function mockDatabase({
  report = REPORT as typeof REPORT | null,
  insertError = null as { code: string } | null,
} = {}) {
  const insert = vi.fn().mockResolvedValue({ error: insertError })

  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table === 'reports') {
      const chain = {
        eq: () => chain,
        single: vi.fn().mockResolvedValue({
          data: report,
          error: report ? null : { message: 'not found' },
        }),
      }
      return { select: vi.fn().mockReturnValue(chain) }
    }
    return { insert }
  }) as never)

  return { insert }
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/reports/:id/confirm', () => {
  it('accepts a citizen standing at the report', async () => {
    mockDatabase()

    const res = await request(makeApp())
      .post('/api/reports/report-1/confirm')
      .send({ lat: 48.7322, lng: 1.3664 })

    expect(res.status).toBe(200)
    expect(res.body.confirmation_count).toBe(4)
  })

  it('refuses a confirmation sent from the sofa', async () => {
    // Paris — 80 km de Dreux. C'est très exactement le geste que l'ancien
    // bouton « Je signale aussi » autorisait, et qui rendait le compteur
    // ininterprétable pour l'agent qui trie sa file.
    mockDatabase()

    const res = await request(makeApp())
      .post('/api/reports/report-1/confirm')
      .send({ lat: 48.8566, lng: 2.3522 })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('too_far')
  })

  it('tolerates ordinary GPS drift — 60 m between two buildings', async () => {
    mockDatabase()

    const res = await request(makeApp())
      .post('/api/reports/report-1/confirm')
      .send({ lat: 48.7327, lng: 1.3667 })

    // Refuser à tort un citoyen réellement sur place est pire que d'accepter
    // quelqu'un à 100 m : dans un cas on perd un constat vrai, dans l'autre on
    // gagne un constat approximatif.
    expect(res.status).toBe(200)
  })

  it('stores the proof, not just the verdict', async () => {
    const { insert } = mockDatabase()

    await request(makeApp())
      .post('/api/reports/report-1/confirm')
      .send({ lat: 48.7322, lng: 1.3664 })

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmed_lat: 48.7322,
        confirmed_lng: 1.3664,
        confirmed_distance_m: expect.any(Number),
      })
    )
  })

  it('requires a position at all', async () => {
    mockDatabase()

    const res = await request(makeApp()).post('/api/reports/report-1/confirm').send({})

    expect(res.status).toBe(400)
  })

  it('rejects a position that is not a number', async () => {
    mockDatabase()

    const res = await request(makeApp())
      .post('/api/reports/report-1/confirm')
      .send({ lat: '48.7322', lng: '1.3664' })

    expect(res.status).toBe(400)
  })

  it('refuses to confirm a resolved report', async () => {
    mockDatabase({ report: { ...REPORT, status: 'resolu' } })

    const res = await request(makeApp())
      .post('/api/reports/report-1/confirm')
      .send({ lat: 48.7322, lng: 1.3664 })

    expect(res.status).toBe(400)
  })

  it('answers 409 rather than silently double-counting', async () => {
    mockDatabase({ insertError: { code: '23505' } })

    const res = await request(makeApp())
      .post('/api/reports/report-1/confirm')
      .send({ lat: 48.7322, lng: 1.3664 })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('already_confirmed')
  })

  it('404s on a report the tenant does not own', async () => {
    mockDatabase({ report: null })

    const res = await request(makeApp())
      .post('/api/reports/report-1/confirm')
      .send({ lat: 48.7322, lng: 1.3664 })

    expect(res.status).toBe(404)
  })
})

describe('distanceMeters', () => {
  it('is zero for the same point', () => {
    expect(distanceMeters(48.7322, 1.3664, 48.7322, 1.3664)).toBe(0)
  })

  it('matches a known distance — Dreux to Paris, about 80 km', () => {
    const distance = distanceMeters(48.7322, 1.3664, 48.8566, 2.3522)

    expect(distance).toBeGreaterThan(70_000)
    expect(distance).toBeLessThan(90_000)
  })

  it('is symmetric', () => {
    expect(distanceMeters(48.73, 1.36, 48.74, 1.37)).toBe(distanceMeters(48.74, 1.37, 48.73, 1.36))
  })
})
