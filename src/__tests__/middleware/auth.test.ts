import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { AppError } from '../../middleware/errorHandler.js'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(),
    },
  },
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { verifyToken, verifyTokenOptional } from '../../middleware/auth.js'

function makeReq(authHeader?: string): Request {
  return {
    headers: { authorization: authHeader },
  } as unknown as Request
}

function makeRes(): Response {
  return {} as Response
}

describe('verifyToken', () => {
  const next = vi.fn() as unknown as NextFunction

  beforeEach(() => { vi.clearAllMocks() })

  it('calls next(AppError 401) when Authorization header is missing', async () => {
    const req = makeReq()
    await verifyToken(req, makeRes(), next)
    expect(next).toHaveBeenCalledWith(expect.any(AppError))
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError
    expect(err.status).toBe(401)
    expect(err.code).toBe('unauthorized')
  })

  it('calls next(AppError 401) when token is invalid', async () => {
    vi.mocked(supabaseAdmin.auth.getUser).mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'Invalid token' } as any,
    })
    const req = makeReq('Bearer invalid-token')
    await verifyToken(req, makeRes(), next)
    expect(next).toHaveBeenCalledWith(expect.any(AppError))
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as AppError
    expect(err.status).toBe(401)
  })

  it('attaches userId and userRole to req when token is valid', async () => {
    vi.mocked(supabaseAdmin.auth.getUser).mockResolvedValueOnce({
      data: {
        user: {
          id: 'user-123',
          email: 'agent@dreux.fr',
          app_metadata: { role: 'agent' },
        } as any,
      },
      error: null,
    })
    const req = makeReq('Bearer valid-token')
    await verifyToken(req, makeRes(), next)
    expect(next).toHaveBeenCalledWith()
    expect((req as any).userId).toBe('user-123')
    expect((req as any).userRole).toBe('agent')
  })

  it('defaults userRole to citizen when app_metadata.role is absent', async () => {
    vi.mocked(supabaseAdmin.auth.getUser).mockResolvedValueOnce({
      data: {
        user: { id: 'user-456', email: 'citizen@example.fr', app_metadata: {} } as any,
      },
      error: null,
    })
    const req = makeReq('Bearer valid-token')
    await verifyToken(req, makeRes(), next)
    expect((req as any).userRole).toBe('citizen')
  })
})

describe('verifyTokenOptional', () => {
  const next = vi.fn() as unknown as NextFunction

  beforeEach(() => { vi.clearAllMocks() })

  it('calls next() without error when Authorization header is absent', async () => {
    const req = makeReq()
    await verifyTokenOptional(req, makeRes(), next)
    expect(next).toHaveBeenCalledWith()
    expect((req as any).userId).toBeUndefined()
  })

  it('attaches userId to req when token is valid', async () => {
    vi.mocked(supabaseAdmin.auth.getUser).mockResolvedValueOnce({
      data: {
        user: { id: 'user-789', email: 'citizen@example.fr', app_metadata: {} } as any,
      },
      error: null,
    })
    const req = makeReq('Bearer valid-token')
    await verifyTokenOptional(req, makeRes(), next)
    expect(next).toHaveBeenCalledWith()
    expect((req as any).userId).toBe('user-789')
  })

  it('calls next() without error when token is invalid (optional)', async () => {
    vi.mocked(supabaseAdmin.auth.getUser).mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'Invalid' } as any,
    })
    const req = makeReq('Bearer bad-token')
    await verifyTokenOptional(req, makeRes(), next)
    expect(next).toHaveBeenCalledWith()
    expect((req as any).userId).toBeUndefined()
  })
})
