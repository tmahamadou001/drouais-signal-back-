import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import { errorHandler } from '../../middleware/errorHandler.js'

// `comments.handler` importe la chaîne d'envoi d'e-mails, qui construit son
// client Resend à l'import et exige une clé. Ce test ne poste rien.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: () => Promise.resolve({ id: 'email-id' }) }
  },
}))

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { getComments } from '../../modules/comments/comments.handler.js'

const REPORT_ID = '11111111-1111-1111-1111-111111111111'
const TENANT = { id: 'tenant-1', slug: 'la-loupe', name: 'La Loupe' }
const CITIZEN_ID = 'citizen-1'

/**
 * Lire un fil ne vaut pas l'avoir lu.
 *
 * La fiche de détail de l'application mobile charge ce fil pour y trouver les
 * photos de résolution. Tant que le serveur marquait lu de lui-même, ouvrir un
 * signalement effaçait le non-lu avant que l'habitant ait rien lu : la pastille
 * disparaissait, le compteur tombait à zéro, et la réponse de la mairie passait
 * inaperçue.
 */

/** Monte les deux tables que `getComments` interroge, et espionne la mise à jour. */
function mockTables() {
  const update = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    }),
  })

  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table === 'reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: REPORT_ID,
                    user_id: CITIZEN_ID,
                    status: 'pris_en_charge',
                    anonymous_token: null,
                  },
                }),
            }),
          }),
        }),
      }
    }

    if (table === 'report_comments') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () =>
                Promise.resolve({
                  data: [
                    {
                      id: 'c1',
                      parent_id: null,
                      author_type: 'agent',
                      author_id: 'agent-1',
                      content: 'Une équipe passe cette semaine.',
                      read_by_citizen: false,
                    },
                  ],
                  error: null,
                }),
            }),
          }),
        }),
        update,
      }
    }

    if (table === 'tenant_users') {
      return {
        select: () => ({ in: () => ({ eq: () => Promise.resolve({ data: [] }) }) }),
      }
    }

    return {}
  }) as never)

  return { update }
}

/** L'habitant auteur du signalement, sans passer par l'authentification. */
function appAsCitizen() {
  const app = express()
  app.use(express.json())
  app.get(
    '/api/reports/:reportId/comments',
    (req: Request, _res: Response, next: NextFunction) => {
      req.tenant = TENANT as never
      req.userId = CITIZEN_ID
      req.userRole = 'citizen' as never
      next()
    },
    getComments,
  )
  app.use(errorHandler)
  return app
}

beforeEach(() => vi.clearAllMocks())

describe('GET /api/reports/:id/comments', () => {
  it('returns the thread without marking anything read', async () => {
    const { update } = mockTables()

    const response = await request(appAsCitizen()).get(`/api/reports/${REPORT_ID}/comments`)

    expect(response.status).toBe(200)
    expect(response.body).toHaveLength(1)
    expect(update).not.toHaveBeenCalled()
  })

  it('marks the commune’s messages read only when the caller asks', async () => {
    const { update } = mockTables()

    const response = await request(appAsCitizen()).get(
      `/api/reports/${REPORT_ID}/comments?mark_read=1`,
    )

    expect(response.status).toBe(200)
    expect(update).toHaveBeenCalledWith({ read_by_citizen: true })
  })

  it('treats any other value as a plain read', async () => {
    const { update } = mockTables()

    await request(appAsCitizen()).get(`/api/reports/${REPORT_ID}/comments?mark_read=true`)

    expect(update).not.toHaveBeenCalled()
  })
})
