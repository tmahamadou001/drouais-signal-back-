import { describe, it, expect } from 'vitest'
import { ownsReport, reportToken } from '../../lib/reportOwnership.js'

const TOKEN = 'a'.repeat(64)

function request(options: { userId?: string; token?: string } = {}) {
  return {
    userId: options.userId,
    header: (name: string) =>
      name === 'X-Report-Token' ? options.token : undefined,
  } as any
}

describe('reportToken', () => {
  it('reads the follow-up token from the header', () => {
    expect(reportToken(request({ token: TOKEN }))).toBe(TOKEN)
  })

  it('returns null when there is none', () => {
    expect(reportToken(request())).toBeNull()
    expect(reportToken(request({ token: '' }))).toBeNull()
  })
})

describe('ownsReport', () => {
  it('recognises the account that filed the report', () => {
    expect(ownsReport(request({ userId: 'u1' }), { user_id: 'u1' })).toBe(true)
  })

  it('refuses another account', () => {
    expect(ownsReport(request({ userId: 'u2' }), { user_id: 'u1' })).toBe(false)
  })

  /**
   * The bug this file exists for: a report filed without an account has no
   * user_id at all, so its author was refused their own thread.
   */
  it('recognises the holder of the follow-up token', () => {
    expect(ownsReport(request({ token: TOKEN }), { user_id: null, anonymous_token: TOKEN })).toBe(true)
  })

  it('refuses a wrong token', () => {
    expect(ownsReport(request({ token: 'b'.repeat(64) }), { user_id: null, anonymous_token: TOKEN })).toBe(false)
  })

  it('refuses a token of the wrong length rather than comparing it', () => {
    expect(ownsReport(request({ token: 'a' }), { user_id: null, anonymous_token: TOKEN })).toBe(false)
  })

  it('refuses a caller with neither account nor token', () => {
    expect(ownsReport(request(), { user_id: null, anonymous_token: TOKEN })).toBe(false)
    expect(ownsReport(request(), { user_id: 'u1' })).toBe(false)
  })

  /**
   * A report with no token cannot be claimed by presenting an empty one.
   */
  it('refuses a token when the report carries none', () => {
    expect(ownsReport(request({ token: TOKEN }), { user_id: 'u1', anonymous_token: null })).toBe(false)
  })

  it('does not let an anonymous session claim a report by a null user_id', () => {
    expect(ownsReport(request({ userId: 'anon' }), { user_id: null, anonymous_token: TOKEN })).toBe(false)
  })
})
