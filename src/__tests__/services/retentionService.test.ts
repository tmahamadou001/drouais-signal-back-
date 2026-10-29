import { describe, it, expect, vi, beforeEach } from 'vitest'

const { supabaseAdmin, removePhoto } = vi.hoisted(() => ({
  supabaseAdmin: { from: vi.fn() },
  removePhoto: vi.fn(),
}))

vi.mock('../../lib/supabaseAdmin.js', () => ({ supabaseAdmin }))
vi.mock('../../lib/photoStorage.js', () => ({ removePhoto }))

import {
  purgeExpiredPersonalData,
  PHOTO_RETENTION_MONTHS_AFTER_RESOLUTION,
  PHOTO_RETENTION_MONTHS_UNRESOLVED,
  AUDIT_LOG_RETENTION_MONTHS,
} from '../../services/retentionService.js'

const NOW = new Date('2026-09-15T12:00:00.000Z')

/** Records every filter, so the test can assert on the boundaries used. */
function selectChain(rows: unknown[]) {
  const filters: Record<string, string> = {}
  const chain: any = {
    filters,
    select: () => chain,
    eq: (column: string, value: string) => { filters[`eq:${column}`] = value; return chain },
    neq: (column: string, value: string) => { filters[`neq:${column}`] = value; return chain },
    not: () => chain,
    lt: (column: string, value: string) => { filters[`lt:${column}`] = value; return chain },
    then: (resolve: (value: unknown) => void) => resolve({ data: rows, error: null }),
  }
  return chain
}

function updateChain() {
  const chain: any = {
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    eq: () => chain,
    not: () => chain,
    lt: () => chain,
    select: () => chain,
    then: (resolve: (value: unknown) => void) => resolve({ data: [], error: null }),
  }
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('purgeExpiredPersonalData', () => {
  it('deletes the photo of a report resolved long enough ago', async () => {
    const resolved = selectChain([{ id: 'r1', photo_url: 'https://x/photo.jpg' }])
    const stale = selectChain([])

    supabaseAdmin.from
      .mockReturnValueOnce(resolved)
      .mockReturnValueOnce(stale)
      .mockReturnValue(updateChain())

    const result = await purgeExpiredPersonalData(NOW)

    expect(removePhoto).toHaveBeenCalledWith('https://x/photo.jpg')
    expect(result.photosRemoved).toBe(1)
  })

  it('counts the two sources together', async () => {
    supabaseAdmin.from
      .mockReturnValueOnce(selectChain([{ id: 'r1', photo_url: 'a' }]))
      .mockReturnValueOnce(selectChain([{ id: 'r2', photo_url: 'b' }, { id: 'r3', photo_url: 'c' }]))
      .mockReturnValue(updateChain())

    expect((await purgeExpiredPersonalData(NOW)).photosRemoved).toBe(3)
  })

  it('measures a resolved report from its last change, not its creation', async () => {
    const resolved = selectChain([])
    supabaseAdmin.from
      .mockReturnValueOnce(resolved)
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValue(updateChain())

    await purgeExpiredPersonalData(NOW)

    expect(resolved.filters['eq:status']).toBe('resolu')
    expect(resolved.filters['lt:updated_at']).toBe('2025-09-15T12:00:00.000Z')
    expect(PHOTO_RETENTION_MONTHS_AFTER_RESOLUTION).toBe(12)
  })

  it('gives an unresolved report the longer window, counted from its creation', async () => {
    const stale = selectChain([])
    supabaseAdmin.from
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(stale)
      .mockReturnValue(updateChain())

    await purgeExpiredPersonalData(NOW)

    expect(stale.filters['neq:status']).toBe('resolu')
    expect(stale.filters['lt:created_at']).toBe('2024-09-15T12:00:00.000Z')
    expect(PHOTO_RETENTION_MONTHS_UNRESOLVED).toBe(24)
  })

  it('drops audit entries past their own window', async () => {
    const logs: any = {
      delete: vi.fn(() => logs),
      lt: vi.fn((column: string, value: string) => { logs.boundary = `${column}<${value}`; return logs }),
      select: () => logs,
      then: (resolve: (value: unknown) => void) => resolve({ data: [{ id: 'l1' }], error: null }),
    }

    supabaseAdmin.from
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(updateChain())
      .mockReturnValueOnce(logs)

    const result = await purgeExpiredPersonalData(NOW)

    expect(logs.boundary).toBe('created_at<2025-09-15T12:00:00.000Z')
    expect(AUDIT_LOG_RETENTION_MONTHS).toBe(12)
    expect(result.auditLogsRemoved).toBe(1)
  })

  it('does nothing when nothing has expired', async () => {
    supabaseAdmin.from
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValue(updateChain())

    const result = await purgeExpiredPersonalData(NOW)

    expect(removePhoto).not.toHaveBeenCalled()
    expect(result).toEqual({ photosRemoved: 0, emailsErased: 0, auditLogsRemoved: 0 })
  })
})
