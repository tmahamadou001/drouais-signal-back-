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
