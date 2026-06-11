import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { ZodError, z } from 'zod'
import {
  AppError,
  errorHandler,
  notFound,
  forbidden,
  badRequest,
} from '../../middleware/errorHandler.js'

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response
  return res
}

const req = {} as Request
const next = vi.fn() as unknown as NextFunction

describe('AppError helpers', () => {
  it('notFound throws an AppError with status 404', () => {
    expect(() => notFound('Signalement')).toThrow(AppError)
    try { notFound('Signalement') } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).status).toBe(404)
      expect((e as AppError).code).toBe('not_found')
    }
  })

  it('forbidden throws an AppError with status 403', () => {
    try { forbidden() } catch (e) {
      expect((e as AppError).status).toBe(403)
      expect((e as AppError).code).toBe('forbidden')
    }
  })

  it('badRequest throws an AppError with status 400 and the given message', () => {
    try { badRequest('Required field.') } catch (e) {
      expect((e as AppError).status).toBe(400)
      expect((e as AppError).code).toBe('bad_request')
      expect((e as AppError).message).toBe('Required field.')
    }
  })
})

describe('errorHandler middleware', () => {
  it('returns the AppError status and code as JSON', () => {
    const res = makeRes()
    const err = new AppError(403, 'forbidden', 'Access denied.')
    errorHandler(err, req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden', message: 'Access denied.' })
  })

  it('returns 422 with field-level details for a ZodError', () => {
    const res = makeRes()
    const schema = z.object({ email: z.string().email() })
    let zodErr: ZodError
    try { schema.parse({ email: 'invalid' }) } catch (e) { zodErr = e as ZodError }
    errorHandler(zodErr!, req, res, next)
    expect(res.status).toHaveBeenCalledWith(422)
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(body.error).toBe('validation_error')
    expect(body.details).toBeInstanceOf(Array)
    expect(body.details[0]).toHaveProperty('field')
    expect(body.details[0]).toHaveProperty('message')
  })

  it('maps PG error code 23505 to 409 conflict', () => {
    const res = makeRes()
    errorHandler({ code: '23505' }, req, res, next)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'conflict' }))
  })

  it('maps PG error code PGRST116 to 404 not_found', () => {
    const res = makeRes()
    errorHandler({ code: 'PGRST116' }, req, res, next)
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'not_found' }))
  })

  it('returns 500 internal_error for unknown errors without leaking the message', () => {
    const res = makeRes()
    errorHandler(new Error('confidential internal detail'), req, res, next)
    expect(res.status).toHaveBeenCalledWith(500)
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(body.error).toBe('internal_error')
    expect(body.message).not.toContain('confidential')
    expect(body).toHaveProperty('errorId')
  })

  it('does not expose the message of an unknown DB error', () => {
    const res = makeRes()
    errorHandler({ code: '99999', message: 'pg internal: secret' }, req, res, next)
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(body.message).not.toContain('secret')
  })
})
