import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The permission matrix, read off the routers themselves.
 *
 * Not a unit test of a function: a test that the routes are *declared* with
 * the guard the product decided on. The failure it exists to catch is the one
 * that already happened — `requireAgent` was written, documented in CLAUDE.md,
 * and used by no route at all, so a member invited as an agent received their
 * email, set a password, and was bounced at the door.
 *
 * Reading the source is deliberate. Mounting every router to probe it would
 * test the mocks; the question here is what the code says.
 */

const ROOT = join(import.meta.dirname, '../..')

function source(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
}

/**
 * Finds the guard a given route declaration carries.
 *
 * Reads the declaration and the few lines after it: some routers put each
 * middleware on its own line, so a one-line window would report "no guard" on
 * a route that is in fact protected — the most dangerous way for this test to
 * be wrong would be the opposite, but a false alarm wastes just as much time.
 */
function guardOf(file: string, declaration: string): string {
  const text = source(file)
  const index = text.indexOf(declaration)
  expect(index, `route introuvable : ${declaration}`).toBeGreaterThan(-1)

  // Up to the handler body, or six lines — whichever comes first.
  const window = text.slice(index, index + 400).split('\n').slice(0, 6).join('\n')
  const guard = ['requireSuperAdmin', 'requireTenantAdmin', 'requireAgent', 'requireTeamMember']
    .find((name) => window.includes(name))

  return guard ?? (window.includes('verifyToken') ? 'verifyToken' : 'none')
}

describe('traiter — ce qu’un agent fait tous les jours', () => {
  const cases: [string, string][] = [
    ['routes/reports.ts', "router.patch('/:id/status'"],
    ['routes/reports.ts', "router.post('/:id/transmit'"],
    ['routes/reports.ts', "router.post('/transmit'"],
    ['routes/reports.ts', "router.get('/service-recipients'"],
    ['modules/comments/comments.router.ts', "'/agent',"],
    ['routes/upload.ts', 'requireAgent,'],
  ]

  it.each(cases)('%s %s is open to agents', (file, declaration) => {
    expect(guardOf(file, declaration)).toBe('requireAgent')
  })
})

describe('régler — ce qui engage la commune', () => {
  const cases: [string, string][] = [
    ['routes/reports.ts', "router.delete('/:id'"],
    ['routes/reports.ts', "router.delete('/'"],
    ['routes/tenant.ts', "router.patch('/config'"],
    ['routes/tenant.ts', "router.put('/categories'"],
    ['routes/tenant.ts', "router.get('/users'"],
    ['routes/tenant.ts', "router.post('/users/invite'"],
    ['routes/tenant.ts', "router.patch('/users/:userId'"],
    ['routes/tenant.ts', "router.delete('/users/:userId'"],
    // Envoyer écrit à des destinataires au nom de la commune ; gérer la liste
    // décide à qui elle écrira chaque semaine.
    ['routes/weeklyReport.ts', "router.post('/weekly-report/send'"],
    ['routes/weeklyReport.ts', "router.post('/weekly-report/recipients'"],
    ['routes/weeklyReport.ts', "router.delete('/weekly-report/recipients/:id'"],
  ]

  it.each(cases)('%s %s stays with administrators', (file, declaration) => {
    expect(guardOf(file, declaration)).toBe('requireTenantAdmin')
  })
})

describe('voir — lectures du back-office', () => {
  /**
   * These carried no guard at all — not even a token. Mounted under
   * `/api/admin`, they inherited only tenant resolution and the slow-down, so
   * anyone could read any commune's overdue count and resolution rate.
   */
  it.each([
    ['routes/admin.ts', "router.get('/stats'"],
    ['routes/admin.ts', "router.get('/performance'"],
    ['routes/heatmap.ts', "router.get('/heatmap'"],
    // La synthèse hebdomadaire est le seul document qui résume la semaine en
    // une page : c'est précisément ce qu'un élu vient consulter.
    ['routes/weeklyReport.ts', "router.get('/weekly-report/preview'"],
    ['routes/weeklyReport.ts', "router.get('/weekly-report/recipients'"],
  ])('%s %s requires a signed-in member of the commune', (file, declaration) => {
    expect(guardOf(file, declaration)).toBe('requireTeamMember')
  })
})

describe('the guards themselves', () => {
  /** A guard nobody calls is a promise nobody keeps. */
  it.each(['requireAgent', 'requireTeamMember', 'requireTenantAdmin', 'requireSuperAdmin'])(
    '%s is used by at least one route',
    (guard) => {
      const routers = [
        'routes/reports.ts', 'routes/admin.ts', 'routes/heatmap.ts', 'routes/tenant.ts',
        'routes/upload.ts', 'routes/audit.ts', 'routes/weeklyReport.ts',
        'modules/comments/comments.router.ts', 'modules/comments/unread.router.ts',
      ]

      const used = routers.some((file) => {
        const text = source(file)
        // An import line does not count as a use.
        return text.split('\n').some((line) => line.includes(guard) && !line.includes('import'))
      })

      expect(used).toBe(true)
    }
  )
})
