import { supabaseAdmin } from '../lib/supabaseAdmin.js'

/**
 * Le journal du traitement, avec le nom de qui a agi.
 *
 * `status_history` ne porte qu'un `agent_id`, et la route rendait les lignes
 * brutes : le back-office savait qu'un agent avait marqué un signalement
 * résolu, jamais lequel. C'est pourtant la question qu'on pose trois semaines
 * plus tard, quand un habitant rappelle — et la frise de suivi, qui répond
 * « où en est-on », ne l'a jamais dit non plus.
 *
 * La jointure se fait ici plutôt que dans la requête : `status_history` n'a pas
 * de clé étrangère vers `tenant_users` (elle pointe sur `auth.users`), donc
 * PostgREST ne peut pas l'imbriquer. Une seconde requête, une seule, pour tous
 * les auteurs distincts de la fiche.
 */

export interface HistoryEntryWithAgent {
  agent_id: string | null
  /** `null` quand l'auteur n'est pas un agent, ou n'est plus dans l'équipe. */
  agent_name: string | null
  [key: string]: unknown
}

export async function withAgentNames<T extends { agent_id: string | null }>(
  history: T[],
  tenantId: string | null | undefined
): Promise<(T & { agent_name: string | null })[]> {
  const agentIds = [...new Set(history.map((entry) => entry.agent_id).filter(Boolean))] as string[]

  if (agentIds.length === 0 || !tenantId) {
    return history.map((entry) => ({ ...entry, agent_name: null }))
  }

  const { data } = await supabaseAdmin
    .from('tenant_users')
    .select('user_id, first_name, last_name')
    .eq('tenant_id', tenantId)
    .in('user_id', agentIds)

  const names = new Map(
    (data ?? []).map((member) => [
      member.user_id,
      [member.first_name, member.last_name].filter(Boolean).join(' ') || null,
    ])
  )

  /**
   * Un agent parti de la commune garde son `agent_id` dans l'historique mais
   * n'a plus de ligne dans `tenant_users` : `agent_name` vaut alors `null`, et
   * l'écran retombe sur « Agent ». Réécrire l'historique pour faire disparaître
   * quelqu'un serait pire — c'est un journal.
   */
  return history.map((entry) => ({
    ...entry,
    agent_name: entry.agent_id ? names.get(entry.agent_id) ?? null : null,
  }))
}
