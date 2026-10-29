import { describe, it, expect } from 'vitest'
import { readLimit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../lib/pagination.js'

describe('readLimit', () => {
  it('falls back to the platform page size', () => {
    // Trois écrans qui rendaient 9, 20 et 25 lignes obligeaient l'agent à
    // réapprendre à chaque onglet où finit une page.
    expect(readLimit(undefined)).toBe(DEFAULT_PAGE_SIZE)
    expect(readLimit('')).toBe(DEFAULT_PAGE_SIZE)
    expect(readLimit('abc')).toBe(DEFAULT_PAGE_SIZE)
  })

  it('honours an explicit limit', () => {
    expect(readLimit('50')).toBe(50)
  })

  it('caps it — a page nobody reads still costs a query', () => {
    expect(readLimit('5000')).toBe(MAX_PAGE_SIZE)
  })

  it('refuses zero and negatives rather than returning an empty page', () => {
    expect(readLimit('0')).toBe(DEFAULT_PAGE_SIZE)
    expect(readLimit('-10')).toBe(DEFAULT_PAGE_SIZE)
  })
})
