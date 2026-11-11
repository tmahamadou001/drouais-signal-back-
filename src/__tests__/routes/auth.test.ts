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

/**
 * Credential grants go through a throwaway client.
 *
 * A session placed on the shared admin client makes every later PostgREST query
 * travel with that user's token instead of the service key — the whole process
 * silently loses its RLS bypass. See `lib/supabaseAuthClient.ts`.
 */
const { credentialsAuth } = vi.hoisted(() => ({
  credentialsAuth: { signInWithPassword: vi.fn(), signUp: vi.fn(), verifyOtp: vi.fn() },
}))

vi.mock('../../lib/supabaseAuthClient.js', () => ({
  createCredentialsClient: () => ({ auth: credentialsAuth }),
}))

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: {
    from: vi.fn(),
    auth: {
      getUser: vi.fn(),
      admin: {
        generateLink: vi.fn(),
        updateUserById: vi.fn(),
        signOut: vi.fn(),
      },
    },
  },
}))

/**
 * Les limiteurs deviennent transparents.
 *
 * `authLimiter` est un singleton de module : il compte les requêtes de tout le
 * fichier sous la même adresse IP, si bien que le dixième test recevait un 429
 * au lieu de la réponse qu'il éprouve. Ce qui est testé ici, ce sont les règles
 * de l'endpoint ; le comptage appartient à `express-rate-limit`.
 */
vi.mock('../../middleware/rateLimits.js', () => ({
  authLimiter: (_req: any, _res: any, next: any) => next(),
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

const SESSION = {
  access_token: 'jeton-acces',
  refresh_token: 'jeton-rafraichissement',
  expires_in: 3600,
  expires_at: 1789000000,
  token_type: 'bearer',
}

const USER = { id: 'user-abc', email: 'agent@mairie.fr', app_metadata: {}, is_anonymous: false }

/** `tenant_users`, dont dépend le rôle rendu avec la session. */
function mockRole(role: string | null) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: role ? { role } : null }),
  }
  vi.mocked(supabaseAdmin.from).mockReturnValue(chain)
}

// ─── POST /api/auth/login ────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRole('admin')
  })

  /**
   * The bug this guard exists for: signing in on the shared admin client left a
   * session on it, and every query after that ran as the signed-in user — RLS
   * on, service key ignored, for the lifetime of the process.
   */
  it('never signs in on the shared admin client', async () => {
    credentialsAuth.signInWithPassword.mockResolvedValue({
      data: { session: SESSION, user: USER },
      error: null,
    } as any)

    await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'agent@mairie.fr', password: 'motdepasse' })

    expect((supabaseAdmin.auth as any).signInWithPassword).toBeUndefined()
    expect(credentialsAuth.signInWithPassword).toHaveBeenCalled()
  })

  it('returns the session and the role in one answer', async () => {
    credentialsAuth.signInWithPassword.mockResolvedValue({
      data: { session: SESSION, user: USER },
      error: null,
    } as any)

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'agent@mairie.fr', password: 'motdepasse' })

    expect(res.status).toBe(200)
    expect(res.body.user).toEqual({
      id: 'user-abc',
      email: 'agent@mairie.fr',
      role: 'admin',
      isAnonymous: false,
    })
    expect(res.body.session.access_token).toBe('jeton-acces')
  })

  /**
   * Telling "unknown address" apart from "wrong password" would turn this
   * endpoint into a way of checking which addresses a town hall employs.
   */
  it('answers the same way for a wrong password and an unknown address', async () => {
    credentialsAuth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: 'Invalid login credentials' },
    } as any)

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'inconnu@mairie.fr', password: 'motdepasse' })

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_credentials')
    expect(JSON.stringify(res.body)).not.toContain('Invalid login credentials')
  })

  it('never leaks anything but the session fields it means to return', async () => {
    credentialsAuth.signInWithPassword.mockResolvedValue({
      data: {
        session: { ...SESSION, provider_token: 'secret-google-token' },
        user: { ...USER, app_metadata: { role: 'admin', provider: 'email' } },
      },
      error: null,
    } as any)

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'agent@mairie.fr', password: 'motdepasse' })

    expect(JSON.stringify(res.body)).not.toContain('secret-google-token')
    expect(res.body.user.app_metadata).toBeUndefined()
  })

  it('normalises the address before using it', async () => {
    credentialsAuth.signInWithPassword.mockResolvedValue({
      data: { session: SESSION, user: USER },
      error: null,
    } as any)

    await request(makeApp())
      .post('/api/auth/login')
      .send({ email: '  Agent@Mairie.FR ', password: 'motdepasse' })

    expect(credentialsAuth.signInWithPassword).toHaveBeenCalledWith({
      email: 'agent@mairie.fr',
      password: 'motdepasse',
    })
  })

  it('refuses a malformed payload before touching the auth provider', async () => {
    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'pas-une-adresse', password: 'court' })

    expect(res.status).toBe(422)
    expect(credentialsAuth.signInWithPassword).not.toHaveBeenCalled()
  })

  it('refuses a password long enough to be a denial of service', async () => {
    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'agent@mairie.fr', password: 'x'.repeat(5000) })

    expect(res.status).toBe(422)
    expect(credentialsAuth.signInWithPassword).not.toHaveBeenCalled()
  })

  /**
   * `super_admin` lives in `app_metadata`, which only the service_role can
   * write. A commune row must never be able to grant it.
   */
  it('reads super_admin from app_metadata, not from the commune table', async () => {
    mockRole('agent')
    credentialsAuth.signInWithPassword.mockResolvedValue({
      data: { session: SESSION, user: { ...USER, app_metadata: { role: 'super_admin' } } },
      error: null,
    } as any)

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'agent@mairie.fr', password: 'motdepasse' })

    expect(res.body.user.role).toBe('super_admin')
  })

  it('treats an account with no row in the commune as a citizen', async () => {
    mockRole(null)
    credentialsAuth.signInWithPassword.mockResolvedValue({
      data: { session: SESSION, user: USER },
      error: null,
    } as any)

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'habitant@exemple.fr', password: 'motdepasse' })

    expect(res.body.user.role).toBe('citizen')
  })
})

// ─── POST /api/auth/logout ───────────────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  beforeEach(() => vi.clearAllMocks())

  it('requires a session', async () => {
    const res = await request(makeApp()).post('/api/auth/logout')

    expect(res.status).toBe(401)
  })

  /**
   * Clearing browser storage left the refresh token alive: anyone who had
   * copied it could keep minting access tokens long after "signing out".
   */
  it('revokes the session on the server, everywhere', async () => {
    vi.mocked(supabaseAdmin.auth.admin.signOut).mockResolvedValue({ error: null } as any)

    const res = await request(makeApp())
      .post('/api/auth/logout')
      .set('Authorization', 'Bearer valid-token')

    expect(res.status).toBe(200)
    expect(supabaseAdmin.auth.admin.signOut).toHaveBeenCalledWith('valid-token', 'global')
  })

  it('still succeeds when the token had already expired', async () => {
    vi.mocked(supabaseAdmin.auth.admin.signOut).mockResolvedValue({
      error: { message: 'token expired' },
    } as any)

    const res = await request(makeApp())
      .post('/api/auth/logout')
      .set('Authorization', 'Bearer valid-token')

    expect(res.status).toBe(200)
  })
})

// ─── POST /api/auth/set-password ─────────────────────────────────────────────

describe('POST /api/auth/set-password', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(makeApp())
      .post('/api/auth/set-password')
      .send({ password: 'NewPassword1!' })

    expect(res.status).toBe(401)
  })

  /**
   * 422, like every other validated endpoint: these routes now go through the
   * shared Zod middleware instead of hand-rolled checks, so a malformed payload
   * answers the same way everywhere.
   */
  it('returns 422 when password is too short', async () => {
    const res = await request(makeApp())
      .post('/api/auth/set-password')
      .set('Authorization', 'Bearer valid-token')
      .send({ password: 'short' })

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('validation_error')
  })

  it('returns 422 when password is missing', async () => {
    const res = await request(makeApp())
      .post('/api/auth/set-password')
      .set('Authorization', 'Bearer valid-token')
      .send({})

    expect(res.status).toBe(422)
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

  it('says a leaked password was refused, rather than answering 500', async () => {
    // An invited agent who has just clicked their invitation link. A server
    // error here reads as a breakdown: they retype the same password, get the
    // same error, and call the town hall.
    vi.mocked(supabaseAdmin.auth.admin.updateUserById).mockResolvedValue({
      data: { user: null as any },
      error: {
        code: 'weak_password',
        message: 'Password is known to be weak and easy to guess',
      } as any,
    })

    const res = await request(makeApp())
      .post('/api/auth/set-password')
      .set('Authorization', 'Bearer valid-token')
      .send({ password: 'Mairie2024!' })

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('weak_password')
    expect(res.body.message).toMatch(/fuites de données/)
  })
})

// ─── POST /api/auth/register ─────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says a leaked password was refused', async () => {
    credentialsAuth.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'weak_password', message: 'Password is known to be weak' },
    })

    const res = await request(makeApp())
      .post('/api/auth/register')
      .send({ email: 'habitant@ville.fr', password: 'Mairie2024!' })

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('weak_password')
  })

  it('still says nothing about an address that is already taken', async () => {
    // The vagueness protects *addresses* — telling them apart would turn this
    // route into a way to check which e-mails a commune employs. A refused
    // password says nothing about whether an account exists.
    credentialsAuth.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'email_exists', message: 'already registered' },
    })

    const res = await request(makeApp())
      .post('/api/auth/register')
      .send({ email: 'habitant@ville.fr', password: 'UnMotDePasseSolide1!' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('signup_failed')
    expect(JSON.stringify(res.body)).not.toMatch(/exist|prise|registered/i)
  })
})

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 422 when email is missing', async () => {
    const res = await request(makeApp())
      .post('/api/auth/forgot-password')
      .send({})

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('validation_error')
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

// ─── POST /api/auth/verify-link ──────────────────────────────────────────────

/**
 * L'échange du jeton reçu par e-mail.
 *
 * C'est ce qui permet au lien d'invitation d'être le nôtre plutôt qu'une URL
 * `…supabase.co/auth/v1/verify`. Publique par nécessité : celui qui l'appelle
 * n'a pas encore de session, c'est tout l'objet de l'appel.
 */
describe('POST /api/auth/verify-link', () => {
  beforeEach(() => vi.clearAllMocks())

  it('exchanges a valid token for a session', async () => {
    credentialsAuth.verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'jeton-invitation' }, user: { id: 'user-abc', email: 'agent@mairie.fr' } },
      error: null,
    })

    const res = await request(makeApp())
      .post('/api/auth/verify-link')
      .send({ token: 'abcdef0123456789abcdef', type: 'invite' })

    expect(res.status).toBe(200)
    expect(res.body.access_token).toBe('jeton-invitation')
    expect(credentialsAuth.verifyOtp).toHaveBeenCalledWith({
      token_hash: 'abcdef0123456789abcdef',
      type: 'invite',
    })
  })

  /** Expiré, déjà utilisé, inventé : une seule réponse, qui ne renseigne personne. */
  it('answers the same way for every bad token', async () => {
    credentialsAuth.verifyOtp.mockResolvedValue({ data: {}, error: { message: 'expired' } })

    const res = await request(makeApp())
      .post('/api/auth/verify-link')
      .send({ token: 'abcdef0123456789abcdef', type: 'invite' })

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_link')
  })

  it('refuses a kind of link that does not exist', async () => {
    const res = await request(makeApp())
      .post('/api/auth/verify-link')
      .send({ token: 'abcdef0123456789abcdef', type: 'signup' })

    // 422 : c'est la réponse du validateur Zod dans ce dépôt.
    expect(res.status).toBe(422)
    expect(credentialsAuth.verifyOtp).not.toHaveBeenCalled()
  })

  /** Le seul champ qu'un inconnu peut poster sans compte : il est borné. */
  it('refuses a token that is absurdly short or long', async () => {
    const short = await request(makeApp())
      .post('/api/auth/verify-link')
      .send({ token: 'abc', type: 'invite' })

    const long = await request(makeApp())
      .post('/api/auth/verify-link')
      .send({ token: 'a'.repeat(5000), type: 'invite' })

    expect(short.status).toBe(422)
    expect(long.status).toBe(422)
    expect(credentialsAuth.verifyOtp).not.toHaveBeenCalled()
  })
})
