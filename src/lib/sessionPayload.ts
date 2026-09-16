import { supabaseAdmin } from './supabaseAdmin.js'
import type { Session, User } from '@supabase/supabase-js'

/**
 * Ce qu'une réponse d'authentification rend au client.
 *
 * Un objet Supabase brut contient bien plus que ce dont un client a besoin —
 * métadonnées d'identité, fournisseurs, horodatages internes — et tout ce qui
 * sort d'ici finit dans le stockage du navigateur. On n'expose donc que ce qui
 * sert, et le rôle est joint à la réponse : il était demandé dans un second
 * appel, si bien que l'application connaissait l'utilisateur une fraction de
 * seconde avant de savoir ce qu'il avait le droit de faire.
 */

export type TenantRole = 'super_admin' | 'admin' | 'agent' | 'observer' | 'citizen'

export interface AuthPayload {
  user: {
    id: string
    email: string | null
    /** Le rôle dans la commune courante, vérifié en base à chaque appel. */
    role: TenantRole
    isAnonymous: boolean
  }
  session: {
    access_token: string
    refresh_token: string
    /** Secondes de validité restantes, telles que Supabase les annonce. */
    expires_in: number
    expires_at: number | null
    token_type: string
  }
}

/**
 * Le rôle d'un compte dans une commune.
 *
 * `app_metadata.role` d'abord — c'est là que vit `super_admin`, et il n'est
 * écrivable que par la service_role. `tenant_users` ensuite, qui décide du reste.
 * Un compte sans ligne est un citoyen : authentifié, sans droits.
 */
export async function resolveRole(user: User, tenantId?: string | null): Promise<TenantRole> {
  if (user.app_metadata?.role === 'super_admin') return 'super_admin'
  if (!tenantId) return 'citizen'

  const { data } = await supabaseAdmin
    .from('tenant_users')
    .select('role')
    .eq('user_id', user.id)
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .maybeSingle()

  return (data?.role as TenantRole) ?? 'citizen'
}

export async function buildAuthPayload(
  user: User,
  session: Session,
  tenantId?: string | null
): Promise<AuthPayload> {
  return {
    user: {
      id: user.id,
      email: user.email ?? null,
      role: await resolveRole(user, tenantId),
      isAnonymous: user.is_anonymous === true,
    },
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      expires_at: session.expires_at ?? null,
      token_type: session.token_type,
    },
  }
}
