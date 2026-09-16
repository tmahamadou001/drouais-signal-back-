import { describe, it, expect } from 'vitest'
import { storagePathFromUrl } from '../../lib/photoStorage.js'

const SIGNED =
  'https://xyz.supabase.co/storage/v1/object/sign/photos/reports/2026/abc.jpg?token=eyJhbGci'

describe('storagePathFromUrl', () => {
  it('reads the path out of a signed URL', () => {
    expect(storagePathFromUrl(SIGNED)).toBe('reports/2026/abc.jpg')
  })

  it('prefixes the folder when the URL does not carry it', () => {
    expect(storagePathFromUrl(
      'https://xyz.supabase.co/storage/v1/object/sign/photos/abc.jpg?token=x'
    )).toBe('reports/abc.jpg')
  })

  it('decodes an escaped path', () => {
    expect(storagePathFromUrl(
      'https://xyz.supabase.co/storage/v1/object/sign/photos/reports/a%20b.jpg?token=x'
    )).toBe('reports/a b.jpg')
  })

  /**
   * A photo whose file cannot be located must not stop a report from being
   * deleted — which is what an exception here would do.
   */
  it('returns null rather than throwing on anything unexpected', () => {
    expect(storagePathFromUrl(null)).toBeNull()
    expect(storagePathFromUrl('')).toBeNull()
    expect(storagePathFromUrl('pas une url')).toBeNull()
    expect(storagePathFromUrl('https://example.com/autre/chemin.jpg')).toBeNull()
  })
})
