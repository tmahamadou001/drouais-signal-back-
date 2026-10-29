import { describe, it, expect } from 'vitest'
import { paginationSchema } from '../../schemas/report.schema.js'
import { readReportFilters } from '../../lib/reportFilters.js'

/**
 * The query string, as the route actually receives it.
 *
 * `validate()` replaces `req.query` with what Zod parsed, and Zod drops keys
 * the schema does not declare. So a filter can be read correctly by
 * `readReportFilters`, be unit-tested against it, and still never work: it is
 * erased one middleware earlier.
 *
 * That is exactly what happened to `source` — the browser sent it, the server
 * deleted it, and the list answered as though nothing had been asked. These
 * tests go through the schema first, which is the only way to catch it.
 */
function throughSchema(query: Record<string, string>) {
  const parsed = paginationSchema.parse({ query, body: {}, params: {} }) as {
    query: Record<string, unknown>
  }
  return readReportFilters(parsed.query)
}

describe('paginationSchema → readReportFilters', () => {
  it('carries every filter the list offers', () => {
    const filters = throughSchema({
      status: 'en_attente',
      category: 'voirie',
      search: 'gare',
      since: '30',
      sort: 'votes',
      overdue: 'true',
      source: 'agent',
    })

    expect(filters).toEqual({
      status: 'en_attente',
      category: 'voirie',
      search: 'gare',
      sinceDays: 30,
      sort: 'votes',
      overdue: true,
      source: 'agent',
    })
  })

  it('keeps the source filter rather than dropping it', () => {
    expect(throughSchema({ source: 'agent' }).source).toBe('agent')
    expect(throughSchema({ source: 'citizen' }).source).toBe('citizen')
  })

  it('defaults to everything when nothing is asked', () => {
    expect(throughSchema({}).source).toBe('all')
  })
})
