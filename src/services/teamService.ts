import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { getAuthAccountMap } from '../lib/authHelpers.js'
import type { TenantUser } from '../types/tenant.js'

/**
 * L'équipe d'une commune, telle qu'un administrateur a besoin de la voir.
 *
 * L'écran listait qui existe. C'est un annuaire, et ce n'est pas la question
 * qu'on se pose en l'ouvrant : on veut savoir **qui a rejoint** et **qui
 * travaille**. Les deux réponses existaient déjà en base, à deux endroits que
 * la route n'interrogeait pas.
 */

/** Fenêtre d'activité : le mois glissant, pas le mois calendaire. */
const ACTIVITY_DAYS = 30

export type MemberStatus = 'invited' | 'active' | 'suspended'

export interface TeamMember extends TenantUser {
  email: string | null
  status: MemberStatus
  last_sign_in_at: string | null
  /** Changements de statut opérés par ce membre sur les 30 derniers jours. */
  handled_30d: number
}

/**
 * Le statut réel d'un membre, en trois états au lieu d'un booléen.
 *
 * `is_active` ne distinguait pas « invité il y a trois semaines, n'a jamais
 * ouvert son e-mail » de « membre actif depuis six mois » : les deux
 * s'affichaient « Actif ». L'administrateur relançait donc à l'aveugle.
 *
 * L'ordre des tests compte : une suspension décidée par la commune prime sur
 * tout le reste, y compris sur une invitation jamais acceptée.
 */
function memberStatus(member: TenantUser, confirmedAt: string | null): MemberStatus {
  if (!member.is_active) return 'suspended'
  return confirmedAt ? 'active' : 'invited'
}

/**
 * Combien de signalements chaque membre a fait avancer, sur 30 jours.
 *
 * Compté sur `status_history.agent_id` : c'est la trace du geste, pas une
 * colonne d'affectation — la plateforme n'assigne pas les signalements, et
 * prétendre le contraire donnerait un chiffre que personne ne pourrait
 * expliquer.
 */
async function handledCounts(tenantId: string): Promise<Map<string, number>> {
  const since = new Date(Date.now() - ACTIVITY_DAYS * 86_400_000).toISOString()
  const counts = new Map<string, number>()

  const { data } = await supabaseAdmin
    .from('status_history')
    .select('agent_id')
    .eq('tenant_id', tenantId)
    .gte('changed_at', since)
    .not('agent_id', 'is', null)

  for (const row of (data ?? []) as { agent_id: string }[]) {
    counts.set(row.agent_id, (counts.get(row.agent_id) ?? 0) + 1)
  }

  return counts
}

export async function listTeam(tenantId: string): Promise<TeamMember[]> {
  const { data, error } = await supabaseAdmin
    .from('tenant_users')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at')

  if (error) throw error

  const members = (data ?? []) as TenantUser[]
  const [accounts, handled] = await Promise.all([
    getAuthAccountMap(members.map((member) => member.user_id)),
    handledCounts(tenantId),
  ])

  return members.map((member) => {
    const account = accounts.get(member.user_id)
    return {
      ...member,
      email: account?.email ?? null,
      status: memberStatus(member, account?.confirmedAt ?? null),
      last_sign_in_at: account?.lastSignInAt ?? null,
      handled_30d: handled.get(member.user_id) ?? 0,
    }
  })
}

/**
 * Combien d'administrateurs actifs restent, en excluant un membre donné.
 *
 * Une commune sans administrateur est une commune qui ne peut plus inviter
 * personne, ni changer un réglage, ni rendre la main — il faut alors passer
 * par un super-administrateur. Rien n'empêchait un administrateur de se
 * rétrograder lui-même ou de révoquer le dernier de ses pairs.
 */
export async function countOtherAdmins(tenantId: string, excludeUserId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from('tenant_users')
    .select('user_id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('role', 'admin')
    .eq('is_active', true)
    .neq('user_id', excludeUserId)

  return count ?? 0
}
