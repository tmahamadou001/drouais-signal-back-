import { supabaseAdmin } from './supabaseAdmin.js'

/**
 * Récupère l'email d'un utilisateur Supabase Auth par son ID.
 * Retourne null si l'utilisateur est introuvable ou en cas d'erreur.
 */
export async function getAuthUserEmail(userId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId)
    return data?.user?.email ?? null
  } catch (err) {
    console.error('[AuthHelpers] getAuthUserEmail failed:', err)
    return null
  }
}

/**
 * Construit une Map userId → email pour une liste d'IDs.
 * Utilise listUsers() car Supabase n'expose pas de lookup batch par ID.
 * Pagine jusqu'à 1000 utilisateurs — suffisant pour tous les tenants actuels.
 */
export async function getAuthEmailMap(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (userIds.length === 0) return map
  try {
    const { data } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    const idSet = new Set(userIds)
    for (const user of data?.users ?? []) {
      if (idSet.has(user.id) && user.email) {
        map.set(user.id, user.email)
      }
    }
  } catch (err) {
    console.error('[AuthHelpers] getAuthEmailMap failed:', err)
  }
  return map
}

/**
 * Ce que le compte Supabase dit d'un membre, au-delà de son adresse.
 *
 * `tenant_users` ne porte qu'un booléen `is_active`, qui ne distingue pas
 * « invité, n'a jamais ouvert son e-mail » de « membre actif depuis six mois ».
 * Un administrateur relançait donc à l'aveugle, ou pas du tout.
 *
 * Les deux dates qui manquaient vivent dans `auth.users` et ne sont lisibles
 * qu'avec la clé service_role : la confirmation d'adresse dit si l'invitation a
 * été acceptée, la dernière connexion dit si le compte sert encore.
 */
export interface AuthAccount {
  email: string | null
  /** L'invitation a été acceptée : l'adresse est confirmée. */
  confirmedAt: string | null
  lastSignInAt: string | null
}

export async function getAuthAccountMap(userIds: string[]): Promise<Map<string, AuthAccount>> {
  const map = new Map<string, AuthAccount>()
  if (userIds.length === 0) return map

  try {
    const { data } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    const wanted = new Set(userIds)

    for (const user of data?.users ?? []) {
      if (!wanted.has(user.id)) continue
      map.set(user.id, {
        email: user.email ?? null,
        confirmedAt: user.email_confirmed_at ?? user.confirmed_at ?? null,
        lastSignInAt: user.last_sign_in_at ?? null,
      })
    }
  } catch (err) {
    console.error('[AuthHelpers] getAuthAccountMap failed:', err)
  }

  return map
}
