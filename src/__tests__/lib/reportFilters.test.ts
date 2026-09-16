import { describe, it, expect, vi, beforeEach } from 'vitest'

// `vi.hoisted` because `vi.mock` is hoisted above every `const` in the file.
const { resolveCategories } = vi.hoisted(() => ({ resolveCategories: vi.fn() }))
vi.mock('../../services/categoryService.js', () => ({ resolveCategories }))

import {
  readReportFilters,
  sanitizeSearch,
  sortColumns,
  overdueFilter,
  applyReportFilters,
} from '../../lib/reportFilters.js'

/** A fake PostgREST chain that records every filter it receives. */
function fakeQuery() {
  const calls: string[] = []
  const chain: any = {
    calls,
    eq: (column: string, value: unknown) => { calls.push(`eq:${column}=${value}`); return chain },
    neq: (column: string, value: unknown) => { calls.push(`neq:${column}=${value}`); return chain },
    gte: (column: string, value: unknown) => { calls.push(`gte:${column}=${value}`); return chain },
    or: (filter: string) => { calls.push(`or:${filter}`); return chain },
  }
  return chain
}

const NOW = new Date('2026-09-15T12:00:00.000Z')

beforeEach(() => {
  resolveCategories.mockReset()
  resolveCategories.mockResolvedValue([])
})

describe('readReportFilters', () => {
  it('defaults to everything, most recent first', () => {
    expect(readReportFilters({})).toEqual({
      status: 'all',
      category: 'all',
      search: '',
      sinceDays: 0,
      sort: 'recent',
      overdue: false,
    })
  })

  it('reads the query string', () => {
    const filters = readReportFilters({
      status: 'en_attente',
      category: 'voirie',
      search: '  rue de la gare ',
      since: '30',
      sort: 'votes',
      overdue: 'true',
    })

    expect(filters).toEqual({
      status: 'en_attente',
      category: 'voirie',
      search: 'rue de la gare',
      sinceDays: 30,
      sort: 'votes',
      overdue: true,
    })
  })

  it('falls back to the default sort when the value is unknown', () => {
    expect(readReportFilters({ sort: 'cheapest' }).sort).toBe('recent')
  })

  it('ignores a negative or unparseable period', () => {
    expect(readReportFilters({ since: '-5' }).sinceDays).toBe(0)
    expect(readReportFilters({ since: 'banane' }).sinceDays).toBe(0)
  })
})

describe('sanitizeSearch', () => {
  it('removes the characters that would break a PostgREST or()', () => {
    expect(sanitizeSearch('rue des Lilas, angle (nord)')).toBe('rue des Lilas angle nord')
  })

  it('removes the ilike wildcards so the user cannot write their own pattern', () => {
    expect(sanitizeSearch('a*b%c')).toBe('a b c')
  })

  it('caps the length', () => {
    expect(sanitizeSearch('x'.repeat(200))).toHaveLength(100)
  })
})

describe('sortColumns', () => {
  it('sorts by date descending by default', () => {
    expect(sortColumns('recent')).toEqual([{ column: 'created_at', ascending: false }])
  })

  it('sorts oldest first', () => {
    expect(sortColumns('oldest')).toEqual([{ column: 'created_at', ascending: true }])
  })

  it('breaks a tie on confirmations with the date, to stay stable', () => {
    expect(sortColumns('votes')).toEqual([
      { column: 'vote_count', ascending: false },
      { column: 'created_at', ascending: false },
    ])
  })
})

describe('overdueFilter', () => {
  it('uses the SLA of each category, not a single threshold', async () => {
    resolveCategories.mockResolvedValue([
      { slug: 'voirie', sla_hours: 72 },
      { slug: 'eau', sla_hours: 24 },
    ])

    const clauses = await overdueFilter('tenant-1', NOW)

    expect(clauses).toBe(
      'and(category.eq.voirie,created_at.lt.2026-09-12T12:00:00.000Z),' +
      'and(category.eq.eau,created_at.lt.2026-09-14T12:00:00.000Z)'
    )
  })

  it('falls back to a week when the category has no SLA', async () => {
    resolveCategories.mockResolvedValue([{ slug: 'autre', sla_hours: 0 }])

    expect(await overdueFilter('tenant-1', NOW)).toContain('2026-09-08T12:00:00.000Z')
  })

  it('returns an empty string when there is no category', async () => {
    expect(await overdueFilter('tenant-1', NOW)).toBe('')
  })
})

describe('applyReportFilters', () => {
  const base = readReportFilters({})

  it('scopes to the tenant and nothing else by default', () => {
    const query = fakeQuery()
    applyReportFilters(query, base, 'tenant-1', '', NOW)

    expect(query.calls).toEqual(['eq:tenant_id=tenant-1'])
  })

  it('does not scope when there is no tenant', () => {
    const query = fakeQuery()
    applyReportFilters(query, base, null, '', NOW)

    expect(query.calls).toEqual([])
  })

  it('applies status and category', () => {
    const query = fakeQuery()
    applyReportFilters(query, { ...base, status: 'resolu', category: 'voirie' }, 'tenant-1', '', NOW)

    expect(query.calls).toContain('eq:status=resolu')
    expect(query.calls).toContain('eq:category=voirie')
  })

  it('turns the period into a date boundary', () => {
    const query = fakeQuery()
    applyReportFilters(query, { ...base, sinceDays: 30 }, 'tenant-1', '', NOW)

    expect(query.calls).toContain('gte:created_at=2026-08-16T12:00:00.000Z')
  })

  it('searches the title, the address and the reference together', () => {
    const query = fakeQuery()
    applyReportFilters(query, { ...base, search: 'gare' }, 'tenant-1', '', NOW)

    expect(query.calls).toContain(
      'or:title.ilike.*gare*,address_approx.ilike.*gare*,reference.ilike.*gare*'
    )
  })

  /**
   * An agent types what the resident reads out. A partial number has to work:
   * nobody dictates the prefix and the year reliably.
   */
  it('finds a reference from the number alone', () => {
    const query = fakeQuery()
    applyReportFilters(query, { ...base, search: 'LAL-2026-00418' }, 'tenant-1', '', NOW)

    expect(query.calls.some((call: string) => call.includes('reference.ilike.*LAL-2026-00418*'))).toBe(true)
  })

  it('excludes resolved reports from the overdue filter', () => {
    const query = fakeQuery()
    applyReportFilters(query, { ...base, overdue: true }, 'tenant-1', 'and(category.eq.voirie,created_at.lt.X)', NOW)

    expect(query.calls).toContain('neq:status=resolu')
    expect(query.calls).toContain('or:and(category.eq.voirie,created_at.lt.X)')
  })

  it('still excludes resolved reports when no category has an SLA', () => {
    const query = fakeQuery()
    applyReportFilters(query, { ...base, overdue: true }, 'tenant-1', '', NOW)

    expect(query.calls).toEqual(['eq:tenant_id=tenant-1', 'neq:status=resolu'])
  })
})
