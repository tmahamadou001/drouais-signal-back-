import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/supabaseAdmin.js', () => ({ supabaseAdmin: { from: vi.fn() } }))

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { withAgentNames } from '../../services/statusHistoryService.js'

/** The ids `tenant_users` was actually asked about. */
let asked: string[] | null = null

function mockTeam(members: { user_id: string; first_name: string | null; last_name: string | null }[]) {
  asked = null
  vi.mocked(supabaseAdmin.from).mockImplementation(() => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      in: async (_column: string, ids: string[]) => {
        asked = ids
        return { data: members }
      },
    }
    return chain
  })
}

const entry = (agent_id: string | null) => ({ id: `h-${agent_id}`, agent_id })

beforeEach(() => vi.clearAllMocks())

describe('withAgentNames', () => {
  it('names the agent behind each change', async () => {
    mockTeam([{ user_id: 'u1', first_name: 'Claire', last_name: 'Meunier' }])

    const result = await withAgentNames([entry('u1')], 'tenant-1')

    expect(result[0].agent_name).toBe('Claire Meunier')
  })

  it('asks about each author once, however many changes they made', async () => {
    mockTeam([{ user_id: 'u1', first_name: 'Claire', last_name: 'Meunier' }])

    await withAgentNames([entry('u1'), entry('u1'), entry('u1')], 'tenant-1')

    expect(asked).toEqual(['u1'])
  })

  it('leaves a service or the platform without a name', async () => {
    // `agent_id` is null for an outside service acting through its link, and
    // for the platform itself. The screen calls those something else.
    mockTeam([])

    const result = await withAgentNames([entry(null)], 'tenant-1')

    expect(result[0].agent_name).toBeNull()
    expect(supabaseAdmin.from).not.toHaveBeenCalled()
  })

  it('keeps the entry when the agent has left the commune', async () => {
    // Their row in `tenant_users` is gone, their `agent_id` stays in history.
    // Rewriting the past to make someone disappear would be worse: it is a log.
    mockTeam([])

    const result = await withAgentNames([entry('gone')], 'tenant-1')

    expect(result).toHaveLength(1)
    expect(result[0].agent_name).toBeNull()
  })
})
