import { describe, it, expect } from 'vitest'
import type { ErrorEvent } from '@sentry/node'
import { beforeSend, scrubText } from '../../lib/sentry.js'

/**
 * Ce que la supervision n'a pas le droit d'emporter.
 *
 * Testé plutôt que relu, parce qu'une erreur ici ne se voit pas : l'événement
 * part, il est accepté, et la donnée est chez un tiers. Le jeton de suivi est
 * le cas qui compte — il est la preuve d'identité de l'auteur d'un dépôt sans
 * compte, et aucune expression régulière ne le reconnaîtrait dans une chaîne
 * quelconque. C'est pourquoi il se neutralise par sa clé et par la forme de
 * l'URL qui le porte, jamais par son contenu.
 */

function event(partial: Partial<ErrorEvent>): ErrorEvent {
  return partial as ErrorEvent
}

describe('scrubText', () => {
  it('redacts a service hand-off token out of a path', () => {
    expect(scrubText('GET /api/service/a1b2c3d4e5 failed')).toBe(
      'GET /api/service/[redacted] failed'
    )
  })

  it('redacts an anonymous follow-up token out of a path', () => {
    expect(scrubText('https://onsignale.fr/signalement/suivi/zX9-token_42')).toBe(
      'https://onsignale.fr/signalement/suivi/[redacted]'
    )
  })

  it('keeps the kind of URL it redacted, because that is the diagnostic', () => {
    expect(scrubText('/api/service/abc')).toContain('/service/')
  })

  it('redacts a token passed as a query parameter, whatever its name', () => {
    expect(scrubText('/api/x?token=abc&apikey=def&page=2')).toBe(
      '/api/x?token=[redacted]&apikey=[redacted]&page=2'
    )
  })

  it('redacts an email address', () => {
    expect(scrubText('no row for agent.dupont+test@ville-dreux.fr')).toBe(
      'no row for [redacted]'
    )
  })

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghij'
    expect(scrubText(`Bearer ${jwt}`)).toBe('Bearer [redacted]')
  })

  it('leaves an ordinary message untouched', () => {
    expect(scrubText('Supabase timeout on reports.select')).toBe(
      'Supabase timeout on reports.select'
    )
  })
})

describe('beforeSend', () => {
  it('drops the request headers, cookies and body wholesale', () => {
    const result = beforeSend(
      event({
        request: {
          url: 'https://api.onsignale.fr/api/reports',
          headers: { authorization: 'Bearer x', cookie: 'sb=1' },
          cookies: { sb: '1' },
          data: { password: 'hunter2' },
        },
      })
    )

    expect(result.request?.headers).toBeUndefined()
    expect(result.request?.cookies).toBeUndefined()
    expect(result.request?.data).toBeUndefined()
  })

  it('drops the user, whose identity never explains a crash', () => {
    const result = beforeSend(event({ user: { id: 'u1', email: 'x@y.fr', ip_address: '1.2.3.4' } }))

    expect(result.user).toBeUndefined()
  })

  it('redacts a token nested in a sensitive key, however deep', () => {
    const result = beforeSend(
      event({
        extra: { query: { filter: { anonymous_token: 'plain-looking-string' } } },
      })
    )

    expect(JSON.stringify(result)).not.toContain('plain-looking-string')
  })

  it('redacts the exception message and the breadcrumb trail', () => {
    const result = beforeSend(
      event({
        exception: { values: [{ type: 'Error', value: 'failed for jean@dreux.fr' }] },
        breadcrumbs: [{ message: 'GET /api/service/tok3n' }],
      })
    )

    expect(result.exception?.values?.[0]?.value).toBe('failed for [redacted]')
    expect(result.breadcrumbs?.[0]?.message).toBe('GET /api/service/[redacted]')
  })

  it('keeps the tags that make an event actionable', () => {
    const result = beforeSend(event({ tags: { tenant: 'dreux', error_id: 'err_abc' } }))

    expect(result.tags).toEqual({ tenant: 'dreux', error_id: 'err_abc' })
  })
})
