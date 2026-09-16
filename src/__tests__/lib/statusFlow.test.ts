import { describe, it, expect } from 'vitest'
import { isRollback, isFinal, isReportStatus, STATUS_ORDER } from '../../lib/statusFlow.js'

describe('isRollback', () => {
  it('sees a step back', () => {
    expect(isRollback('pris_en_charge', 'en_attente')).toBe(true)
    expect(isRollback('resolu', 'transmis')).toBe(true)
  })

  it('does not see a step forward as one', () => {
    expect(isRollback('en_attente', 'pris_en_charge')).toBe(false)
  })

  it('does not see standing still as one', () => {
    expect(isRollback('transmis', 'transmis')).toBe(false)
  })

  /** An unknown status must not be reported as a correction of anything. */
  it('says nothing about a status it does not know', () => {
    expect(isRollback('inconnu', 'en_attente')).toBe(false)
    expect(isRollback('resolu', 'inconnu')).toBe(false)
  })
})

describe('isFinal', () => {
  it('holds only for resolved', () => {
    expect(isFinal('resolu')).toBe(true)
    expect(STATUS_ORDER.filter((status) => status !== 'resolu').some(isFinal)).toBe(false)
  })
})

describe('isReportStatus', () => {
  it('accepts the four statuses and nothing else', () => {
    expect(STATUS_ORDER.every(isReportStatus)).toBe(true)
    expect(isReportStatus('en_cours')).toBe(false)
    expect(isReportStatus(undefined)).toBe(false)
  })
})
