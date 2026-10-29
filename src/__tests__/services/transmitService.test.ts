import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

vi.mock('../../services/categoryService.js', () => ({
  resolveCategory: vi.fn(),
}))

vi.mock('../../services/notificationService.js', () => ({
  sendServiceNotification: vi.fn(),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { resolveCategory } from '../../services/categoryService.js'
import { sendServiceNotification } from '../../services/notificationService.js'
import { transmitReport, transmitReports } from '../../services/transmitService.js'

const OPTIONS = { tenantId: 'tenant-1', tenantSlug: 'dreux' }

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: 'report-1',
    reference: 'DRX-2026-00042',
    title: 'Lampadaire éteint',
    category: 'eclairage',
    status: 'en_attente',
    description: null,
    address_approx: null,
    photo_url: null,
    created_at: '2026-01-01T00:00:00Z',
    is_anonymous: false,
    ...overrides,
  }
}

/** The report lookup, as PostgREST chains it. */
function mockReport(data: unknown) {
  const single = vi.fn().mockResolvedValue({ data })
  const eqTenant = vi.fn().mockReturnValue({ single })
  const eqId = vi.fn().mockReturnValue({ eq: eqTenant })
  const select = vi.fn().mockReturnValue({ eq: eqId })
  const update = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
  })
  vi.mocked(supabaseAdmin.from).mockReturnValue({ select, update } as any)
  return { update }
}

describe('transmitReport', () => {
  beforeEach(() => vi.clearAllMocks())

  it('transmits a waiting report', async () => {
    mockReport(report())
    vi.mocked(sendServiceNotification).mockResolvedValue(true)

    const outcome = await transmitReport('report-1', { ...OPTIONS, recipients: ['regie@ville.fr'] })

    expect(outcome).toMatchObject({ id: 'report-1', reference: 'DRX-2026-00042', ok: true })
    expect(sendServiceNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: ['regie@ville.fr'], currentStatus: 'en_attente' })
    )
  })

  /** A closed report has nothing left to hand to anyone. */
  it('refuses a resolved report without sending anything', async () => {
    mockReport(report({ status: 'resolu' }))

    const outcome = await transmitReport('report-1', OPTIONS)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('déjà résolu')
    expect(sendServiceNotification).not.toHaveBeenCalled()
  })

  it('reports a report that is not in this tenant as missing', async () => {
    mockReport(null)

    const outcome = await transmitReport('report-1', OPTIONS)

    expect(outcome).toMatchObject({ ok: false, reference: null })
    expect(sendServiceNotification).not.toHaveBeenCalled()
  })

  it('says so when the email did not leave', async () => {
    mockReport(report())
    vi.mocked(sendServiceNotification).mockResolvedValue(false)

    expect((await transmitReport('report-1', OPTIONS)).ok).toBe(false)
  })

  /**
   * Written before the send: the email can fail, the agent's decision stays.
   * It is what turns a one-off into configuration.
   */
  it('remembers the addresses on the category before sending', async () => {
    const { update } = mockReport(report())
    vi.mocked(resolveCategory).mockResolvedValue({ service_emails: ['ancien@ville.fr'] } as any)
    vi.mocked(sendServiceNotification).mockResolvedValue(false)

    await transmitReport('report-1', {
      ...OPTIONS,
      recipients: ['regie@ville.fr'],
      serviceName: 'Régie éclairage',
      remember: true,
    })

    expect(update).toHaveBeenCalledWith({
      service_emails: ['ancien@ville.fr', 'regie@ville.fr'],
      service_name: 'Régie éclairage',
    })
  })

  it('does not touch the category when the agent did not ask', async () => {
    const { update } = mockReport(report())
    vi.mocked(sendServiceNotification).mockResolvedValue(true)

    await transmitReport('report-1', { ...OPTIONS, recipients: ['regie@ville.fr'] })

    expect(update).not.toHaveBeenCalled()
  })
})

describe('transmitReports', () => {
  beforeEach(() => vi.clearAllMocks())

  /**
   * A partial result is the common case — one report already resolved, one
   * category with no recipient — so the caller gets the detail rather than a
   * single verdict on the whole batch.
   */
  it('reports each outcome separately', async () => {
    const single = vi.fn()
      .mockResolvedValueOnce({ data: report({ id: 'a' }) })
      .mockResolvedValueOnce({ data: report({ id: 'b', status: 'resolu' }) })
    const eqTenant = vi.fn().mockReturnValue({ single })
    const eqId = vi.fn().mockReturnValue({ eq: eqTenant })
    vi.mocked(supabaseAdmin.from).mockReturnValue({ select: vi.fn().mockReturnValue({ eq: eqId }) } as any)
    vi.mocked(sendServiceNotification).mockResolvedValue(true)

    const outcomes = await transmitReports(['a', 'b'], OPTIONS)

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false])
    expect(sendServiceNotification).toHaveBeenCalledTimes(1)
  })
})
