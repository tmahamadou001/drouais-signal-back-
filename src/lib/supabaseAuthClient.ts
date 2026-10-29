import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import 'dotenv/config'

/**
 * Un client jetable pour les échanges d'identifiants.
 *
 * `supabaseAdmin` est partagé par tout le processus, et `supabase-js` choisit
 * l'en-tête `Authorization` de **chaque requête** ainsi :
 *
 *     const { data } = await this.auth.getSession()
 *     return data.session?.access_token ?? this.supabaseKey
 *
 * Autrement dit : dès qu'une session existe sur un client, toutes ses requêtes
 * PostgREST partent avec le jeton de cet utilisateur, et non plus avec la clé
 * `service_role`. Le contournement du RLS disparaît — pour le processus entier,
 * et jusqu'à son redémarrage.
 *
 * `signInWithPassword` et `signUp` créent précisément une session. Les appeler
 * sur le client partagé transformait donc le serveur, à la première connexion,
 * en client authentifié comme le dernier utilisateur connecté. D'où les
 * « infinite recursion detected in policy for relation tenant_users » : les
 * requêtes se mettaient soudain à traverser le RLS.
 *
 * Un client neuf par échange coûte un objet et aucune requête réseau. La
 * session qu'il acquiert meurt avec lui.
 */
export function createCredentialsClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Variables SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY manquantes.')
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      // Rien ne doit survivre à l'appel : ni en mémoire partagée, ni sur disque.
      storage: undefined,
    },
  })
}
