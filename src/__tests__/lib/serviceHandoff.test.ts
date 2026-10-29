import { describe, it, expect, vi, beforeEach } from 'vitest'

const { supabaseAdmin } = vi.hoisted(() => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('../../lib/supabaseAdmin.js', () => ({ supabaseAdmin }))

import { createHandoff, findHandoff, hashToken, handoffUrl } from '../../lib/serviceHandoff.js'

const NOW = new Date('2026-09-15T12:00:00.000Z')

function selectChain(row: unknown) {
  const chain: any = {
    select: () => chain,
    eq: (_column: string, value: string) => { chain.lookedUp = value; return chain },
    maybeSingle: async () => ({ data: row }),
  }
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('hashToken', () => {
  /**
   * Only the fingerprint is stored. A leak of `service_handoffs` must not hand
   * anyone the right to act on reports — the same rule as a password table.
   */
  it('is stable and does not reveal the token', () => {
    const digest = hashToken('abc')

    expect(digest).toHaveLength(64)
    expect(digest).not.toContain('abc')
    expect(hashToken('abc')).toBe(digest)
  })

  it('differs for a different token', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'))
  })
})

describe('createHandoff', () => {
  it('stores the fingerprint, never the token', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    supabaseAdmin.from.mockReturnValue({ insert })

    const token = await createHandoff({
      reportId: 'r1',
      tenantId: 't1',
      recipient: 'voirie@mairie.fr',
      serviceName: 'Service Voirie',
      category: 'voirie',
    })

    expect(token).toBeTruthy()
    const row = insert.mock.calls[0][0]
    expect(row.token_hash).toBe(hashToken(token!))
    expect(JSON.stringify(row)).not.toContain(token!)
  })

  /**
   * One link per recipient: it is what makes an action attributable in the
   * audit trail. A shared token would make every action anonymous.
   */
  it('keeps the recipient with the link', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    supabaseAdmin.from.mockReturnValue({ insert })

    await createHandoff({
      reportId: 'r1', tenantId: 't1',
      recipient: 'voirie@mairie.fr', serviceName: null, category: 'voirie',
    })

    expect(insert.mock.calls[0][0].recipient).toBe('voirie@mairie.fr')
  })

  it('returns null rather than a token that was never stored', async () => {
    supabaseAdmin.from.mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: { message: 'nope' } }),
    })

    expect(await createHandoff({
      reportId: 'r1', tenantId: 't1', recipient: 'x@y.fr', serviceName: null, category: 'voirie',
    })).toBeNull()
  })
})

describe('findHandoff', () => {
  const valid = {
    id: 'h1',
    report_id: 'r1',
    tenant_id: 't1',
    recipient: 'voirie@mairie.fr',
    service_name: 'Service Voirie',
    category: 'voirie',
    expires_at: '2026-10-15T12:00:00.000Z',
    acknowledged_at: null,
    completed_at: null,
  }

  it('looks the link up by fingerprint, not by token', async () => {
    const chain = selectChain(valid)
    supabaseAdmin.from.mockReturnValue(chain)

    await findHandoff('mon-jeton', NOW)

    expect(chain.lookedUp).toBe(hashToken('mon-jeton'))
  })

  it('finds a live link', async () => {
    supabaseAdmin.from.mockReturnValue(selectChain(valid))

    const result = await findHandoff('mon-jeton', NOW)

    expect(result.ok).toBe(true)
  })

  it('refuses a token nobody issued', async () => {
    supabaseAdmin.from.mockReturnValue(selectChain(null))

    expect(await findHandoff('inventé', NOW)).toEqual({ ok: false, reason: 'unknown' })
  })

  /**
   * An action link that never expires ends up circulating as an attachment.
   */
  it('refuses an expired link, and says which it is', async () => {
    supabaseAdmin.from.mockReturnValue(selectChain({ ...valid, expires_at: '2026-09-01T00:00:00.000Z' }))

    expect(await findHandoff('mon-jeton', NOW)).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('handoffUrl', () => {
  it('points at the public page of the link', () => {
    expect(handoffUrl('abc')).toMatch(/\/service\/abc$/)
  })
})
