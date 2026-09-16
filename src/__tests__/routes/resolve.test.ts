import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { errorHandler } from '../../middleware/errorHandler.js'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

vi.mock('../../services/geoRouting.js', () => ({
  resolve: vi.fn(),
  isPlausiblePosition: vi.fn().mockReturnValue(true),
}))

vi.mock('../../services/prospectService.js', () => ({
  joinWaitlist: vi.fn(),
}))

import tenantsRouter from '../../routes/tenants.js'
import { resolve as resolveLocation } from '../../services/geoRouting.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

const PARIS = { inseeCode: '75104', communeName: 'Paris', addressLabel: null }

beforeEach(() => vi.clearAllMocks())

describe('GET /api/tenants/resolve', () => {
  it('reports a partner commune as covered', async () => {
    vi.mocked(resolveLocation).mockResolvedValue({
      ...PARIS,
      tenant: { slug: 'dreux', name: 'Dreux', status: 'active' } as never,
    })

    const res = await request(makeApp()).get('/api/tenants/resolve?lat=48.73&lng=1.36')

    expect(res.status).toBe(200)
    expect(res.body.tenant).toMatchObject({ slug: 'dreux' })
  })

  it('hides a prospect tenant — a shell is not a subscription', async () => {
    vi.mocked(resolveLocation).mockResolvedValue({
      ...PARIS,
      tenant: { slug: 'paris-75104', name: 'Paris', status: 'prospect' } as never,
    })

    const res = await request(makeApp()).get('/api/tenants/resolve?lat=48.857&lng=2.295')

    expect(res.status).toBe(200)
    // Le rendre comme n'importe quel tenant faisait adopter à l'app un slug
    // sans configuration ni catégories : l'habitant recevait un 500 au
    // chargement et restait bloqué à l'entrée.
    expect(res.body.tenant).toBeNull()
    // La commune, elle, reste nommée : c'est ce qui permet l'écran hors
    // couverture et l'inscription à la liste d'attente.
    expect(res.body.commune_name).toBe('Paris')
    expect(res.body.insee_code).toBe('75104')
  })

  it('names the commune even with no tenant at all', async () => {
    vi.mocked(resolveLocation).mockResolvedValue({ ...PARIS, tenant: null })

    const res = await request(makeApp()).get('/api/tenants/resolve?lat=48.857&lng=2.295')

    expect(res.status).toBe(200)
    expect(res.body.tenant).toBeNull()
  })

  it('answers 503 when neither geocoder can name the commune', async () => {
    vi.mocked(resolveLocation).mockResolvedValue(null)

    const res = await request(makeApp()).get('/api/tenants/resolve?lat=48.857&lng=2.295')

    // 503 et non 404 : la commune existe, c'est nous qui ne savons pas la
    // nommer à cet instant.
    expect(res.status).toBe(503)
  })
})
