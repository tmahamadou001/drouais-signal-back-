import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { createCredentialsClient } from '../lib/supabaseAuthClient.js'
import { tenantWebUrl } from '../lib/tenantUrl.js'
import { AppError } from '../middleware/errorHandler.js'

/**
 * Les liens d'invitation et de réinitialisation, et leur vérification.
 *
 * Deux défauts s'ajoutaient ici, et chacun suffisait à casser le parcours.
 *
 * **1. Le lien pointait sur Supabase.** `generateLink` rend un `action_link`
 * de la forme `https://<projet>.supabase.co/auth/v1/verify?token=…`, et c'est
 * ce que recevait l'invité. Notre fournisseur d'authentification n'a rien à
 * faire dans un e-mail envoyé à un agent municipal : l'adresse ne ressemble
 * pas au service, elle est invérifiable par celui qui la lit, et elle grave
 * dans des boîtes mail une dépendance qu'on veut pouvoir remplacer. Le reste
 * du produit ne parle plus à Supabase qu'à travers l'API ; ce chemin était le
 * dernier à y déroger.
 *
 * `generateLink` rend aussi un `hashed_token`, qui est l'élément de preuve.
 * On compose donc **notre** URL avec, et c'est l'API qui l'échange.
 *
 * **2. Il pointait sur l'apex.** `redirectTo` valait `${CLIENT_URL}/set-password`,
 * et `CLIENT_URL` vaut `https://onsignale.fr` — qui sert désormais le site de
 * présentation, pas l'application. L'invité arrivait sur une page qui n'existe
 * pas. C'est la même méprise que les liens de notification corrigés par
 * `tenantWebUrl`, et au même endroit : l'espace d'une commune vit sur son
 * sous-domaine.
 */

export type AccountLinkType = 'invite' | 'recovery'

/**
 * Le lien à envoyer, et l'identifiant du compte concerné.
 *
 * `null` quand Supabase refuse d'émettre un lien — une adresse déjà
 * enregistrée pour une invitation, par exemple. L'appelant décide quoi en
 * faire : il connaît le contexte, pas nous.
 */
export interface AccountLink {
  url: string
  userId: string | null
}

export async function buildAccountLink(params: {
  type: AccountLinkType
  email: string
  /** La commune dont on rejoint l'espace. Son sous-domaine porte le lien. */
  tenantSlug: string | null
}): Promise<AccountLink | null> {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: params.type,
    email: params.email,
  })

  if (error || !data?.properties?.hashed_token) return null

  const base = tenantWebUrl(params.tenantSlug)
  const url = new URL(`${base}/set-password`)
  url.searchParams.set('token', data.properties.hashed_token)
  url.searchParams.set('type', params.type)

  return { url: url.toString(), userId: data.user?.id ?? null }
}

/**
 * Échange le jeton d'un lien contre une session.
 *
 * Sur un client **jetable**, jamais sur `supabaseAdmin` : `verifyOtp` ouvre
 * une session, et `supabase-js` choisit l'en-tête `Authorization` de chaque
 * requête à partir de la session du client. Une session posée sur le client
 * partagé ferait perdre le contournement du RLS au processus entier — c'est
 * la raison d'être de `lib/supabaseAuthClient.ts`.
 *
 * Le jeton est à usage unique et expire : Supabase s'en charge, et on ne
 * distingue pas « expiré » de « déjà utilisé » de « inventé ». Les trois se
 * répondent de la même façon, parce que les distinguer renseignerait qui
 * essaie.
 */
export async function redeemAccountLink(params: {
  token: string
  type: AccountLinkType
}): Promise<{ accessToken: string; userId: string; email: string | null }> {
  const client = createCredentialsClient()

  const { data, error } = await client.auth.verifyOtp({
    token_hash: params.token,
    type: params.type,
  })

  if (error || !data?.session || !data.user) {
    throw new AppError(
      401,
      'invalid_link',
      'Ce lien n’est plus valable. Demandez une nouvelle invitation à votre administrateur.'
    )
  }

  // Ce qui ouvre le droit de poser un mot de passe, quelques minutes durant.
  rememberRedemption(data.user.id)

  return {
    accessToken: data.session.access_token,
    userId: data.user.id,
    email: data.user.email ?? null,
  }
}

/**
 * Les échanges de lien récents, et le droit qu'ils ouvrent.
 *
 * `POST /api/auth/set-password` n'exigeait qu'un jeton d'accès valide : tout
 * porteur d'une session changeait le mot de passe sans connaître l'ancien et
 * sans venir d'un lien de récupération. Un jeton recopié sur un poste partagé
 * devenait une prise de contrôle définitive — et la déconnexion globale n'y
 * pouvait plus rien, puisque l'attaquant avait le mot de passe.
 *
 * Le droit de poser un mot de passe vient donc de **ce qui l'a précédé** :
 * avoir échangé un lien d'invitation ou de réinitialisation, il y a peu.
 *
 * En mémoire, volontairement. C'est une autorisation de quelques minutes, pour
 * un geste qui suit immédiatement : la persister demanderait une table, un
 * nettoyage, et une écriture sur le chemin le plus sensible de l'API. Un
 * redémarrage pendant qu'un invité choisit son mot de passe le renvoie au
 * lien, qui est encore valable — c'est le mauvais cas, et il est bénin.
 */
const REDEMPTION_TTL_MS = 15 * 60 * 1000

const redemptions = new Map<string, number>()

/** Purge paresseuse : rien ne tourne en arrière-plan pour une poignée de clés. */
function forgetExpired(now: number): void {
  for (const [userId, expiresAt] of redemptions) {
    if (expiresAt <= now) redemptions.delete(userId)
  }
}

export function rememberRedemption(userId: string, now = Date.now()): void {
  forgetExpired(now)
  redemptions.set(userId, now + REDEMPTION_TTL_MS)
}

/**
 * Ce compte vient-il d'échanger un lien ?
 *
 * Consommé à la lecture : une autorisation sert une fois. Deux appels
 * simultanés ne peuvent donc pas poser deux mots de passe.
 */
export function consumeRedemption(userId: string, now = Date.now()): boolean {
  const expiresAt = redemptions.get(userId)
  redemptions.delete(userId)

  return expiresAt !== undefined && expiresAt > now
}

/** Pour les tests : l'état en mémoire ne doit pas fuir d'un cas à l'autre. */
export function clearRedemptions(): void {
  redemptions.clear()
}
