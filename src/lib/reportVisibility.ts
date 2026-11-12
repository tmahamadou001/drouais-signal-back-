import { supabaseAdmin } from './supabaseAdmin.js'
import { teamRoleFrom } from './teamRoles.js'

/**
 * Ce qu'un signalement montre, et à qui.
 *
 * `GET /api/reports/:id` rendait la **ligne entière** (`select('*')`), sur une
 * route ouverte sans compte. Elle contenait `anonymous_token` : le secret que
 * le serveur remet une fois à l'auteur d'un dépôt sans compte, et qui lui sert
 * ensuite de preuve d'identité pour lire le fil avec sa mairie et y répondre.
 *
 * Autrement dit, la route publiait la clé que `lib/reportOwnership.ts` protège
 * — comparaison à durée constante comprise. N'importe qui pouvait parcourir la
 * liste publique, récolter les jetons, lire les conversations privées des
 * habitants et **écrire à la mairie en se faisant passer pour eux**. L'audit du
 * 12 novembre 2026 a relevé 22 jetons exposés sur 47 signalements en
 * production ; ils ont été renouvelés depuis.
 *
 * La règle tient en trois niveaux :
 *
 *  - **tout le monde** voit le problème : ce qui est signalé, où, dans quel
 *    état. C'est le principe du service ;
 *  - **l'auteur** ne voit rien de plus ici — il n'en a pas besoin, et son jeton,
 *    il l'a déjà ;
 *  - **l'équipe de la commune** voit en plus ce qui sert à traiter : qui a
 *    déposé, le code INSEE, et le journal avec ses motifs et ses auteurs.
 *
 * `anonymous_token` et `anonymous_email` ne sortent **jamais**, pour personne.
 */

/** Les colonnes que la fiche expose, dans tous les cas. */
export const PUBLIC_REPORT_COLUMNS = [
  'id',
  'reference',
  'title',
  'description',
  'category',
  'status',
  'resolution_source',
  'created_at',
  'updated_at',
  'address_approx',
  'lat',
  'lng',
  'photo_url',
  'vote_count',
  'source',
  'tenant_id',
  'is_published',
  'is_anonymous',
].join(', ')

/**
 * Ce qu'il faut lire en plus pour décider, sans jamais le rendre tel quel.
 *
 * `user_id` et `anonymous_token` sont la matière de `ownsReport` : on ne peut
 * pas vérifier l'appartenance sans les avoir lus. Ils sont retirés de la
 * réponse juste après.
 */
export const REPORT_DECISION_COLUMNS = `${PUBLIC_REPORT_COLUMNS}, user_id, insee_code, anonymous_token, anonymous_email`

/**
 * La ligne telle qu'on la lit ici.
 *
 * `supabase-js` déduit le type des lignes de la **chaîne littérale** passée à
 * `select()`. Une liste de colonnes construite ailleurs est un `string`
 * ordinaire : l'inférence abandonne et rend un type d'erreur. On déclare donc
 * la forme attendue, comme le fait déjà `LIST_COLUMNS` pour la liste publique.
 */
export interface ReportRow {
  id: string
  tenant_id: string
  is_published: boolean
  user_id: string | null
  anonymous_token: string | null
  anonymous_email: string | null
  insee_code: string | null
  [column: string]: unknown
}

export type Audience = 'public' | 'team'

/**
 * L'appelant fait-il partie de l'équipe de cette commune ?
 *
 * Une seule requête, et seulement quand elle peut répondre oui : une session
 * anonyme — celle que l'application ouvre pour que ses requêtes portent un
 * jeton vérifiable — n'appartient à aucune équipe, et cette route est le
 * chemin le plus chaud de l'API. Le rôle de plateforme, lui, est déjà dans le
 * jeton (`app_metadata`), donc gratuit.
 */
export async function audienceFor(params: {
  userId?: string
  userRole?: string
  isAnonymousUser?: boolean
  tenantId: string
}): Promise<Audience> {
  if (params.userRole === 'super_admin') return 'team'
  if (!params.userId || params.isAnonymousUser) return 'public'

  const { data } = await supabaseAdmin
    .from('tenant_users')
    .select('role, is_active')
    .eq('user_id', params.userId)
    .eq('tenant_id', params.tenantId)
    .maybeSingle()

  if (!data?.is_active) return 'public'

  return teamRoleFrom(data.role) ? 'team' : 'public'
}

/** La fiche, débarrassée de ce que cet interlocuteur n'a pas à voir. */
export function visibleReport<T extends Record<string, unknown>>(
  report: T,
  audience: Audience
): Record<string, unknown> {
  const { anonymous_token, anonymous_email, user_id, insee_code, ...common } = report

  if (audience === 'team') {
    // Ni le jeton ni l'adresse : le back-office apprend qu'un contact existe
    // par le champ `contact`, jamais lequel.
    return { ...common, user_id, insee_code }
  }

  return common
}

/**
 * Le journal, vu du dehors.
 *
 * Les dates et les étapes sont publiques — la frise de l'application les
 * affiche, et c'est ce qui répond à « où en est mon signalement ». Le **motif**
 * et l'auteur ne le sont pas : un agent y écrit pour ses collègues, parfois le
 * nom d'un prestataire ou la raison d'un retour en arrière.
 */
export function visibleHistory<T extends Record<string, unknown>>(
  history: T[],
  audience: Audience
): Record<string, unknown>[] {
  if (audience === 'team') return history

  return history.map(({ comment, agent_id, agent_name, ...rest }) => rest)
}
