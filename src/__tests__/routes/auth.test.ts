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
      getUser: vi.fn(),
      admin: {
        generateLink: vi.fn(),
        updateUserById: vi.fn(),
      },
    },
  },
}))

// verifyToken : simule la validation du token Authorization
vi.mock('../../middleware/auth.js', () => ({
  verifyToken: (req: any, res: any, next: any) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer valid-token')) {
      res.status(401).json({ error: 'unauthorized', message: 'Token invalide ou expiré.' })
      return
    }
    req.userId = 'user-abc'
    next()
  },
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import authRouter from '../../routes/auth.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  // Simule resolveTenant qui injecte req.tenant (pour forgot-password)
  app.use((req: any, _res: any, next: any) => {
    req.tenant = { id: 'tenant-1', slug: 'dreux', name: 'Dreux', status: 'active' }
    next()
  })
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}

// ─── POST /api/auth/set-password ─────────────────────────────────────────────

describe('POST /api/auth/set-password', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(makeApp())
      .post('/api/auth/set-password')
      .send({ password: 'NewPassword1!' })

    expect(res.status).toBe(401)
  })

  it('returns 400 when password is too short', async () => {
    const res = await request(makeApp())
      .post('/api/auth/set-password')
      .set('Authorization', 'Bearer valid-token')
      .send({ password: 'short' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad_request')
  })

  it('returns 400 when password is missing', async () => {
    const res = await request(makeApp())
      .post('/api/auth/set-password')
      .set('Authorization', 'Bearer valid-token')
      .send({})

    expect(res.status).toBe(400)
  })

  it('returns 200 and updates password on success', async () => {
    vi.mocked(supabaseAdmin.auth.admin.updateUserById).mockResolvedValue({
      data: { user: { id: 'user-abc' } as any },
      error: null,
    })

    const res = await request(makeApp())
      .post('/api/auth/set-password')
      .set('Authorization', 'Bearer valid-token')
      .send({ password: 'NewSecurePass1!' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(supabaseAdmin.auth.admin.updateUserById).toHaveBeenCalledWith(
      'user-abc',
      { password: 'NewSecurePass1!' }
    )
  })

  it('returns 500 when Supabase updateUserById fails', async () => {
    vi.mocked(supabaseAdmin.auth.admin.updateUserById).mockResolvedValue({
      data: { user: null as any },
      error: { message: 'DB error' } as any,
    })

    const res = await request(makeApp())
      .post('/api/auth/set-password')
      .set('Authorization', 'Bearer valid-token')
      .send({ password: 'NewSecurePass1!' })

    expect(res.status).toBe(500)
  })
})

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when email is missing', async () => {
    const res = await request(makeApp())
      .post('/api/auth/forgot-password')
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad_request')
  })

  it('returns 200 even when email does not exist (no enumeration)', async () => {
    vi.mocked(supabaseAdmin.auth.admin.generateLink).mockResolvedValue({
      data: { user: null, properties: null } as any,
      error: { message: 'User not found' } as any,
    })

    const configSingle = vi.fn().mockResolvedValue({ data: { city_name: 'Dreux' }, error: null })
    const configEq     = vi.fn().mockReturnValue({ single: configSingle })
    const configSelect = vi.fn().mockReturnValue({ eq: configEq })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select: configSelect } as any)

    const res = await request(makeApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'unknown@dreux.fr' })

    // Toujours 200 — on ne révèle pas si le compte existe
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
  })

  it('returns 200 and sends reset email on success', async () => {
    vi.mocked(supabaseAdmin.auth.admin.generateLink).mockResolvedValue({
      data: {
        user: { id: 'user-abc', email: 'jean@dreux.fr' } as any,
        properties: { action_link: 'https://supabase.co/recovery?token=xyz' } as any,
      },
      error: null,
    })

    const configSingle = vi.fn().mockResolvedValue({ data: { city_name: 'Dreux' }, error: null })
    const configEq     = vi.fn().mockReturnValue({ single: configSingle })
    const configSelect = vi.fn().mockReturnValue({ eq: configEq })

    const memberSingle = vi.fn().mockResolvedValue({ data: { first_name: 'Jean' }, error: null })
    const memberEq2    = vi.fn().mockReturnValue({ single: memberSingle })
    const memberEq1    = vi.fn().mockReturnValue({ eq: memberEq2 })
    const memberSelect = vi.fn().mockReturnValue({ eq: memberEq1 })

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'tenant_configs') return { select: configSelect } as any
      if (table === 'tenant_users')   return { select: memberSelect } as any
      return {} as any
    })

    const res = await request(makeApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'jean@dreux.fr' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(supabaseAdmin.auth.admin.generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery', email: 'jean@dreux.fr' })
    )
  })
})
