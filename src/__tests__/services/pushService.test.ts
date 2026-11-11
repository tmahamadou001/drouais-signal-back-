import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

vi.mock('../../services/notificationPreferences.js', () => ({
  allowsPush: vi.fn(),
}))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { allowsPush } from '../../services/notificationPreferences.js'
import { pushAgentComment, pushStatusChange } from '../../services/pushService.js'

const USER = 'citizen-1'

/**
 * Qui reçoit un push, et sur quels appareils.
 *
 * Le filtre de commune a été retiré : la ligne de `device_tokens` est upsertée
 * sur le jeton, donc un appareil ne porte que la dernière commune suivie.
 * Filtrer dessus revenait à ne prévenir un habitant que s'il suivait encore la
 * commune de son propre signalement.
 */

/** Monte `device_tokens` et rend les filtres `eq` appliqués à la requête. */
function mockTokens(tokens: string[]) {
  const filters: Record<string, unknown> = {}

  // La requête est attendue après le dernier `eq` : chaque `eq` rend donc un
  // objet qui est à la fois une promesse et un maillon de la chaîne.
  const result = { data: tokens.map((token) => ({ token })), error: null }
  const chain = {
    eq: vi.fn((column: string, value: unknown) => {
      filters[column] = value
      return Object.assign(Promise.resolve(result), chain)
    }),
  }

  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table === 'device_tokens') return { select: () => chain }
    return {}
  }) as never)

  return { filters }
}

beforeEach(() => {
  vi.clearAllMocks()
  // `fetch` est appelé par Expo ; aucun test ici ne vérifie l'envoi lui-même.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ data: [] }) }))
})

describe('push recipients', () => {
  it('targets every device of the account, whatever commune it registered under', async () => {
    vi.mocked(allowsPush).mockResolvedValue(true)
    const { filters } = mockTokens(['ExponentPushToken[a]'])

    await pushStatusChange({
      userId: USER,
      reportId: 'report-1',
      reportTitle: 'Nid-de-poule',
      newStatus: 'resolu',
    })

    expect(filters.user_id).toBe(USER)
    expect(filters).not.toHaveProperty('tenant_id')
  })

  it('sends nothing when the account refused this kind of notification', async () => {
    vi.mocked(allowsPush).mockResolvedValue(false)
    mockTokens(['ExponentPushToken[a]'])

    await pushAgentComment({
      userId: USER,
      reportId: 'report-1',
      reportTitle: 'Nid-de-poule',
      excerpt: 'Une équipe passe cette semaine.',
    })

    expect(fetch).not.toHaveBeenCalled()
  })

  /** `en_attente` est l'état de naissance : aucune transition n'y mène. */
  it('does not wake a phone for a status nobody transitions into', async () => {
    vi.mocked(allowsPush).mockResolvedValue(true)
    mockTokens(['ExponentPushToken[a]'])

    await pushStatusChange({
      userId: USER,
      reportId: 'report-1',
      reportTitle: 'Nid-de-poule',
      newStatus: 'en_attente',
    })

    expect(allowsPush).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
