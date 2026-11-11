import { describe, it, expect } from 'vitest'
import {
  isPartner,
  publishesReports,
  isCommunityMode,
  isBrowsable,
  publicationEffect,
  isLaunch,
  isTenantStatus,
} from '../../lib/tenantMode.js'

/**
 * Le régime d'une commune, statut par statut.
 *
 * Ces tests valent surtout pour les deux cas qu'on oublie : `suspended`, qui
 * n'est ni partenaire ni publique, et `community`, qui est publique sans être
 * partenaire. La règle implicite d'avant la migration 040 — « tout ce qui
 * n'est pas prospect est public » — passerait l'un et échouerait sur l'autre.
 */

describe('tenant mode', () => {
  it('treats only trial, active and demo as partners', () => {
    expect(isPartner('active')).toBe(true)
    expect(isPartner('trial')).toBe(true)
    expect(isPartner('demo')).toBe(true)

    expect(isPartner('community')).toBe(false)
    expect(isPartner('prospect')).toBe(false)
    expect(isPartner('suspended')).toBe(false)
  })

  it('publishes for every status but prospect and suspended', () => {
    expect(publishesReports('community')).toBe(true)
    expect(publishesReports('active')).toBe(true)

    expect(publishesReports('prospect')).toBe(false)
    expect(publishesReports('suspended')).toBe(false)
  })

  it('flags community mode alone as having no town hall', () => {
    expect(isCommunityMode('community')).toBe(true)
    expect(isCommunityMode('active')).toBe(false)
    expect(isCommunityMode('prospect')).toBe(false)
  })

  it('offers browsable communes exactly where something is published', () => {
    expect(isBrowsable('community')).toBe(true)
    expect(isBrowsable('prospect')).toBe(false)
    expect(isBrowsable('suspended')).toBe(false)
  })

  it('rejects an unknown status', () => {
    expect(isTenantStatus('community')).toBe(true)
    expect(isTenantStatus('citoyenne')).toBe(false)
    expect(isTenantStatus(null)).toBe(false)
  })
})

describe('publication effect', () => {
  it('publishes the backlog when a silent commune opens', () => {
    expect(publicationEffect('prospect', 'community')).toBe('publish')
    expect(publicationEffect('prospect', 'active')).toBe('publish')
  })

  /** Le point de la décision : un départ ramène au silence, pas au mode citoyen. */
  it('unpublishes everything when a partner leaves', () => {
    expect(publicationEffect('active', 'prospect')).toBe('unpublish')
    expect(publicationEffect('active', 'suspended')).toBe('unpublish')
    expect(publicationEffect('community', 'prospect')).toBe('unpublish')
  })

  it('does nothing when both sides publish, or neither does', () => {
    expect(publicationEffect('community', 'active')).toBe('none')
    expect(publicationEffect('trial', 'active')).toBe('none')
    expect(publicationEffect('prospect', 'suspended')).toBe('none')
  })
})

describe('launch', () => {
  it('fires when a commune becomes a partner, from either state', () => {
    expect(isLaunch('prospect', 'active')).toBe(true)
    expect(isLaunch('community', 'active')).toBe(true)
  })

  it('does not fire between partner statuses, nor when opening to the public', () => {
    expect(isLaunch('trial', 'active')).toBe(false)
    expect(isLaunch('prospect', 'community')).toBe(false)
    expect(isLaunch('active', 'prospect')).toBe(false)
  })
})
