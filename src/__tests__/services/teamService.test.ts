import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('../../lib/authHelpers.js', () => ({ getAuthAccountMap: vi.fn() }))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { getAuthAccountMap } from '../../lib/authHelpers.js'
import { listTeam } from '../../services/teamService.js'

function member(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'u1',
    tenant_id: 'tenant-1',
    role: 'agent',
    is_active: true,
    first_name: 'Claire',
    last_name: 'Meunier',
    job_title: null,
    invited_at: '2026-09-01T00:00:00Z',
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

/** `tenant_users` then `status_history`, in the order `listTeam` asks. */
function mockTables(members: unknown[], history: { agent_id: string }[]) {
  vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    if (table === 'tenant_users') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: async () => ({ data: members, error: null }),
      }
      return chain
    }
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      not: async () => ({ data: history }),
    }
    return chain
  })
}

beforeEach(() => vi.clearAllMocks())

describe('listTeam', () => {
  /**
   * `is_active` alone could not tell "invited three weeks ago, never opened
   * the email" from "active member for six months": both showed as active, so
   * an administrator chased people at random, or not at all.
   */
  it('calls an unconfirmed account invited, not active', async () => {
    mockTables([member()], [])
    vi.mocked(getAuthAccountMap).mockResolvedValue(
      new Map([['u1', { email: 'claire@mairie.fr', confirmedAt: null, lastSignInAt: null }]])
    )

    const [row] = await listTeam('tenant-1')

    expect(row.status).toBe('invited')
    expect(row.email).toBe('claire@mairie.fr')
  })

  it('calls a confirmed account active', async () => {
    mockTables([member()], [])
    vi.mocked(getAuthAccountMap).mockResolvedValue(
      new Map([['u1', {
        email: 'claire@mairie.fr',
        confirmedAt: '2026-09-02T00:00:00Z',
        lastSignInAt: '2026-09-15T08:00:00Z',
      }]])
    )

    const [row] = await listTeam('tenant-1')

    expect(row.status).toBe('active')
    expect(row.last_sign_in_at).toBe('2026-09-15T08:00:00Z')
  })

  /**
   * A suspension is the commune's decision: it outranks everything else,
   * including an invitation that was never accepted.
   */
  it('calls a suspended member suspended, accepted invitation or not', async () => {
    mockTables([member({ is_active: false })], [])
    vi.mocked(getAuthAccountMap).mockResolvedValue(
      new Map([['u1', { email: 'claire@mairie.fr', confirmedAt: '2026-09-02T00:00:00Z', lastSignInAt: null }]])
    )

    expect((await listTeam('tenant-1'))[0].status).toBe('suspended')
  })

  /** Counted off `status_history`: the trace of the gesture, not an assignment. */
  it('counts what each member moved over the window', async () => {
    mockTables(
      [member({ user_id: 'u1' }), member({ user_id: 'u2' })],
      [{ agent_id: 'u1' }, { agent_id: 'u1' }, { agent_id: 'u2' }]
    )
    vi.mocked(getAuthAccountMap).mockResolvedValue(new Map())

    const rows = await listTeam('tenant-1')

    expect(rows.find((row) => row.user_id === 'u1')?.handled_30d).toBe(2)
    expect(rows.find((row) => row.user_id === 'u2')?.handled_30d).toBe(1)
  })

  /**
   * A member with no Supabase account still has to appear: dropping the row
   * would hide someone who holds a role in the commune.
   */
  it('keeps a member whose account could not be read', async () => {
    mockTables([member()], [])
    vi.mocked(getAuthAccountMap).mockResolvedValue(new Map())

    const [row] = await listTeam('tenant-1')

    expect(row.email).toBeNull()
    expect(row.status).toBe('invited')
    expect(row.handled_30d).toBe(0)
  })
})
