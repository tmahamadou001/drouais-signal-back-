import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from '../helpers/createTestApp.js'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn() },
}))

vi.mock('../../lib/serviceHandoff.js', () => ({
  findHandoff: vi.fn(),
}))

vi.mock('../../services/auditService.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../middleware/rateLimits.js', () => ({
  serviceHandoffLimiter: (_req: any, _res: any, next: any) => next(),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { findHandoff } from '../../lib/serviceHandoff.js'
import { createAuditLog } from '../../services/auditService.js'
import handoffRouter from '../../routes/serviceHandoff.js'

const app = () => createTestApp('/api/service', handoffRouter)

function handoff(overrides: Record<string, unknown> = {}) {
  return {
    id: 'handoff-1',
    report_id: 'report-1',
    tenant_id: 'tenant-1',
    recipient: 'regie@ville.fr',
    service_name: 'Régie éclairage',
    category: 'eclairage',
    acknowledged_at: null,
    completed_at: null,
    expires_at: '2026-12-31T00:00:00Z',
    ...overrides,
  }
}

function report(status = 'transmis') {
  return {
    id: 'report-1',
    reference: 'DRX-2026-00042',
    title: 'Lampadaire éteint',
    description: null,
    category: 'eclairage',
    status,
    address_approx: null,
    lat: 48.7,
    lng: 1.3,
    photo_url: null,
    created_at: '2026-09-01T00:00:00Z',
  }
}

/**
 * The report and tenant lookups, and the `service_handoffs` stamp.
 *
 * `eqCalls` records every column/value pair the report query filtered on: the
 * tenant filter is what the assertions below actually check.
 */
function mockTables(reportRow: unknown, tenantName = 'Dreux') {
  const eqCalls: [string, unknown][] = []

  vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    if (table === 'reports') {
      const chain: any = {
        select: () => chain,
        eq: (column: string, value: unknown) => { eqCalls.push([column, value]); return chain },
        single: async () => ({ data: reportRow }),
      }
      return chain as any
    }
    if (table === 'tenants') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({ data: { name: tenantName } }),
      }
      return chain as any
    }
    if (table === 'service_handoffs') {
      return { update: () => ({ eq: async () => ({ error: null }) }) } as any
    }
    return {} as any
  })

  return { eqCalls }
}

beforeEach(() => vi.clearAllMocks())

describe('GET /api/service/:token', () => {
  /**
   * This is the only route on the platform that serves data with neither an
   * account nor a tenant header. Isolation that holds only by construction
   * gives way to the first query added on top of it.
   */
  it('reads the report within the commune the link belongs to', async () => {
    vi.mocked(findHandoff).mockResolvedValue({ ok: true, handoff: handoff() } as any)
    const { eqCalls } = mockTables(report())

    const res = await request(app()).get('/api/service/token-abc')

    expect(res.status).toBe(200)
    expect(eqCalls).toContainEqual(['tenant_id', 'tenant-1'])
    expect(eqCalls).toContainEqual(['id', 'report-1'])
  })

  it('tells the recipient which kind of dead link it is', async () => {
    vi.mocked(findHandoff).mockResolvedValue({ ok: false, reason: 'expired' } as any)

    const res = await request(app()).get('/api/service/token-abc')

    expect(res.status).toBe(410)
    expect(res.body.error).toBe('handoff_expired')
  })

  /**
   * The commune keeps the report: it can close it while the link is still
   * valid. The service was left in front of two buttons on a settled report
   * because the screen never read the status it was already being sent.
   */
  it('says when the commune has closed the report itself', async () => {
    vi.mocked(findHandoff).mockResolvedValue({ ok: true, handoff: handoff() } as any)
    mockTables(report('resolu'))

    const res = await request(app()).get('/api/service/token-abc')

    expect(res.body.closedByCommune).toBe(true)
  })

  it('does not call it closed by the commune when the service closed it', async () => {
    vi.mocked(findHandoff).mockResolvedValue({
      ok: true,
      handoff: handoff({ completed_at: '2026-09-10T00:00:00Z' }),
    } as any)
    mockTables(report('resolu'))

    const res = await request(app()).get('/api/service/token-abc')

    expect(res.body.closedByCommune).toBe(false)
  })

  /** No personal data of the resident travels on this route, ever. */
  it('returns nothing about the person who reported', async () => {
    vi.mocked(findHandoff).mockResolvedValue({ ok: true, handoff: handoff() } as any)
    mockTables(report())

    const res = await request(app()).get('/api/service/token-abc')

    expect(JSON.stringify(res.body)).not.toMatch(/user_id|anonymous_email|anonymous_token/)
  })
})

describe('POST /api/service/:token/ack', () => {
  it('moves the report to taken charge and audits the recipient', async () => {
    vi.mocked(findHandoff).mockResolvedValue({ ok: true, handoff: handoff() } as any)
    mockTables(report())
    vi.mocked(supabaseAdmin.rpc).mockResolvedValue({ error: null } as any)

    const res = await request(app()).post('/api/service/token-abc/ack').send({})

    expect(res.status).toBe(200)
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      'update_report_status_atomic',
      expect.objectContaining({ p_new_status: 'pris_en_charge', p_agent_id: null })
    )
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ userEmail: 'regie@ville.fr', userRole: 'service' })
    )
  })

  /**
   * "We are coming on Thursday" is exactly what a commune wants to know when
   * it sees the acknowledgement. Reserving the note for completion forced the
   * service to wait until the job was done to say it.
   */
  it('carries the note into the history comment', async () => {
    vi.mocked(findHandoff).mockResolvedValue({ ok: true, handoff: handoff() } as any)
    mockTables(report())
    vi.mocked(supabaseAdmin.rpc).mockResolvedValue({ error: null } as any)

    await request(app()).post('/api/service/token-abc/ack').send({ note: 'Passage jeudi' })

    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      'update_report_status_atomic',
      expect.objectContaining({ p_comment: 'Régie éclairage : Passage jeudi' })
    )
  })

  /**
   * The commune may have closed the report meanwhile. The token is still
   * valid — nothing about it changed — but it no longer opens anything, and
   * the service must not be able to pull a final status backwards.
   */
  it('refuses to act on a report the commune has resolved', async () => {
    vi.mocked(findHandoff).mockResolvedValue({ ok: true, handoff: handoff() } as any)
    mockTables(report('resolu'))

    const res = await request(app()).post('/api/service/token-abc/ack').send({})

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('already_closed')
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled()
  })

  it('refuses a link that has already been used to close', async () => {
    vi.mocked(findHandoff).mockResolvedValue({
      ok: true,
      handoff: handoff({ completed_at: '2026-09-10T00:00:00Z' }),
    } as any)
    mockTables(report())

    const res = await request(app()).post('/api/service/token-abc/done').send({})

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('already_completed')
  })
})
