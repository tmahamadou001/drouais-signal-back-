import { describe, it, expect, vi, beforeEach } from 'vitest'

// `vi.hoisted` : `vi.mock` est hissé au-dessus des déclarations, et une `const`
// ordinaire n'existerait pas encore quand la fausse classe est construite.
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }))

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendEmail }
  },
}))

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

vi.mock('../../templates/brand.js', () => ({
  logoImg: () => '',
  plainSubject: (subject: string) => subject,
  EMAIL_COLORS: {},
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { sendWeeklyReport, sendScheduledWeeklyReports } from '../../lib/weeklyReportGenerator.js'

/** Gemini n'est pas joignable depuis un test ; le texte se dégrade tout seul. */
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

/**
 * Un faux PostgREST : chaque `.eq()` est enregistré, et la chaîne se résout sur
 * la table interrogée. Ce sont précisément ces `.eq('tenant_id', …)` qui
 * manquaient et qui envoyaient les chiffres de toutes les communes à tout le
 * monde.
 */
function mockTables(rows: Record<string, unknown[]>) {
  const filters: Record<string, [string, unknown][]> = {}

  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    filters[table] ??= []

    const chain: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown) =>
        resolve({ data: rows[table] ?? [], error: null }),
      maybeSingle: () =>
        Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }),
    }

    for (const method of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'gt', 'not', 'order', 'limit']) {
      chain[method] = (...args: unknown[]) => {
        if (method === 'eq' || method === 'in') {
          filters[table].push([args[0] as string, args[1]])
        }
        return chain
      }
    }

    return chain
  }) as never)

  return filters
}

beforeEach(() => {
  vi.clearAllMocks()
  sendEmail.mockResolvedValue({ data: { id: 'email-1' }, error: null })
})

describe('sendWeeklyReport', () => {
  it('scopes every figure to one commune', async () => {
    const filters = mockTables({
      reports: [],
      tenant_configs: [{ city_name: 'Dreux' }],
      weekly_report_recipients: [{ email: 'maire@dreux.fr', name: 'Le maire' }],
    })

    await sendWeeklyReport('tenant-1')

    // Sans ce filtre, le rapport de Dreux contenait les chiffres de toute la
    // France — prospects compris.
    expect(filters.reports.some(([column]) => column === 'tenant_id')).toBe(true)
    for (const [column, value] of filters.reports) {
      if (column === 'tenant_id') expect(value).toBe('tenant-1')
    }
  })

  it('sends only to that commune’s recipients', async () => {
    const filters = mockTables({
      reports: [],
      tenant_configs: [{ city_name: 'Dreux' }],
      weekly_report_recipients: [{ email: 'maire@dreux.fr', name: 'Le maire' }],
    })

    await sendWeeklyReport('tenant-1')

    expect(filters.weekly_report_recipients).toContainEqual(['tenant_id', 'tenant-1'])
    expect(sendEmail).toHaveBeenCalledOnce()
    expect(sendEmail.mock.calls[0][0].to).toBe('maire@dreux.fr')
  })

  it('names the commune in the subject', async () => {
    mockTables({
      reports: [],
      tenant_configs: [{ city_name: 'La Loupe' }],
      weekly_report_recipients: [{ email: 'maire@la-loupe.fr', name: 'Le maire' }],
    })

    await sendWeeklyReport('tenant-2')

    expect(sendEmail.mock.calls[0][0].subject).toContain('La Loupe')
  })

  it('sends nothing when the commune has no active recipient', async () => {
    mockTables({
      reports: [],
      tenant_configs: [{ city_name: 'Dreux' }],
      weekly_report_recipients: [],
    })

    await sendWeeklyReport('tenant-1')

    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('keeps going when one recipient fails', async () => {
    mockTables({
      reports: [],
      tenant_configs: [{ city_name: 'Dreux' }],
      weekly_report_recipients: [
        { email: 'casse@dreux.fr', name: 'A' },
        { email: 'maire@dreux.fr', name: 'B' },
      ],
    })
    sendEmail.mockRejectedValueOnce(new Error('adresse rejetée'))

    await sendWeeklyReport('tenant-1')

    // Un destinataire en échec ne doit pas priver les autres de leur rapport.
    expect(sendEmail).toHaveBeenCalledTimes(2)
  })
})

describe('sendScheduledWeeklyReports', () => {
  const DREUX = {
    tenant_id: 'tenant-1',
    weekly_report_day: 1,
    weekly_report_hour: 8,
    tenants: { id: 'tenant-1', name: 'Dreux', status: 'active' },
  }
  const LA_LOUPE = {
    tenant_id: 'tenant-2',
    weekly_report_day: 4,
    weekly_report_hour: 18,
    tenants: { id: 'tenant-2', name: 'La Loupe', status: 'active' },
  }

  it('serves only the communes whose slot it is', async () => {
    mockTables({
      tenant_configs: [DREUX, LA_LOUPE],
      reports: [],
      weekly_report_recipients: [],
    })

    // Lundi 8 h — le créneau de Dreux, pas celui de La Loupe. Ces deux réglages
    // existaient dans l'admin et n'étaient lus par personne.
    expect(await sendScheduledWeeklyReports(new Date('2026-09-14T08:00:00'))).toBe(1)
  })

  it('sends nothing outside any slot', async () => {
    mockTables({
      tenant_configs: [DREUX],
      reports: [],
      weekly_report_recipients: [],
    })

    expect(await sendScheduledWeeklyReports(new Date('2026-09-14T09:00:00'))).toBe(0)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
