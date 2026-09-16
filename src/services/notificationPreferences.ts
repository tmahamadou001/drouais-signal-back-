import crypto from 'crypto'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'

/**
 * Qui reçoit quoi, et par quel canal.
 *
 * Deux axes qui se croisent, jamais deux listes indépendantes : les canaux
 * (`email`, `push`) et les événements (`status`, `comment`). Les traiter
 * séparément autorise des états contradictoires — « e-mail activé », « statut
 * désactivé », et rien qui dise ce qu'il advient d'un changement de statut.
 *
 * Deux asymétries structurelles sont assumées ici plutôt que masquées :
 *
 *  - un citoyen **anonyme** n'a pas de compte. Il n'a que l'e-mail, et
 *    seulement s'il a laissé une adresse. Sa seule préférence exprimable est le
 *    désabonnement, qui vit donc sur l'adresse et non sur le compte ;
 *  - un citoyen **sans appareil enregistré** n'a pas de push. La grille lui
 *    montre quand même les quatre cases : ce qu'il règle vaudra à l'install.
 */

export type Channel = 'email' | 'push'
export type NotificationEvent = 'status' | 'comment'

export interface NotificationPreferences {
  email_status: boolean
  email_comment: boolean
  push_status: boolean
  push_comment: boolean
}

/**
 * Tout est activé par défaut.
 *
 * Un citoyen qui installe l'app et n'ouvre jamais cet écran s'attend à être
 * prévenu de son propre signalement ; le silence passerait pour une panne.
 */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  email_status: true,
  email_comment: true,
  push_status: true,
  push_comment: true,
}

export async function getPreferences(userId: string): Promise<NotificationPreferences> {
  const { data, error } = await supabaseAdmin
    .from('notification_preferences')
    .select('email_status, email_comment, push_status, push_comment')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    // Ne jamais rendre muet sur une erreur de lecture : une notification de
    // trop se remarque et se corrige, une notification perdue, non.
    console.error('[Préférences] Lecture impossible:', error.message)
    return DEFAULT_PREFERENCES
  }

  return { ...DEFAULT_PREFERENCES, ...(data ?? {}) }
}

export async function setPreferences(
  userId: string,
  patch: Partial<NotificationPreferences>
): Promise<NotificationPreferences> {
  const next = { ...(await getPreferences(userId)), ...patch }

  const { error } = await supabaseAdmin
    .from('notification_preferences')
    .upsert({ user_id: userId, ...next, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })

  if (error) throw error

  return next
}

/** `true` si ce push doit partir. */
export async function allowsPush(userId: string, event: NotificationEvent): Promise<boolean> {
  const preferences = await getPreferences(userId)
  return event === 'status' ? preferences.push_status : preferences.push_comment
}

/**
 * `true` si cet e-mail doit partir.
 *
 * La liste de suppression prime sur la grille : elle est la seule expression
 * possible pour un citoyen sans compte, et un clic sur « Se désabonner » dans
 * Gmail doit valoir pour tout le monde, compte ou pas.
 */
export async function allowsEmail(
  recipient: { userId?: string | null; email: string },
  event: NotificationEvent
): Promise<boolean> {
  if (await isOptedOut(recipient.email)) return false
  if (!recipient.userId) return true

  const preferences = await getPreferences(recipient.userId)
  return event === 'status' ? preferences.email_status : preferences.email_comment
}

export async function isOptedOut(email: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('email_optouts')
    .select('email')
    .eq('email', normalize(email))
    .maybeSingle()

  if (error) {
    console.error('[Préférences] Lecture des désabonnements impossible:', error.message)
    return false
  }

  return Boolean(data)
}

export async function optOut(email: string, reason = 'list_unsubscribe'): Promise<void> {
  const { error } = await supabaseAdmin
    .from('email_optouts')
    .upsert({ email: normalize(email), reason }, { onConflict: 'email', ignoreDuplicates: true })

  if (error) throw error
}

export async function optIn(email: string): Promise<void> {
  const { error } = await supabaseAdmin.from('email_optouts').delete().eq('email', normalize(email))
  if (error) throw error
}

// ─── Lien de désabonnement ───────────────────────────────────────────────────

/**
 * Le secret qui signe les liens.
 *
 * `UNSUBSCRIBE_SECRET` s'il est défini ; à défaut la clé service_role, qui est
 * déjà requise au démarrage et n'est jamais exposée. La conséquence de ce repli
 * est qu'une rotation de la clé invalide les liens déjà envoyés — acceptable
 * pour des liens dont la durée de vie utile se compte en jours, et la raison
 * pour laquelle la variable dédiée existe.
 */
function secret(): string {
  return process.env.UNSUBSCRIBE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-unsubscribe-secret'
}

function normalize(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Signé plutôt que stocké, et l'adresse voyage encodée.
 *
 * Un jeton en base demanderait une ligne par destinataire, un nettoyage, et une
 * écriture sur le chemin d'envoi. Un HMAC ne demande rien et se vérifie hors
 * ligne — c'est un lien de désabonnement, pas une session.
 *
 * L'adresse est portée par le jeton lui-même plutôt que par un paramètre en
 * clair : une URL traverse les journaux du serveur, les référents et
 * l'historique du navigateur, et une adresse e-mail n'a rien à y faire.
 */
export function unsubscribeToken(email: string): string {
  const payload = Buffer.from(normalize(email)).toString('base64url')
  const signature = crypto.createHmac('sha256', secret()).update(payload).digest('base64url')

  return `${payload}.${signature}`
}

/** L'adresse que ce jeton désigne, ou `null` s'il est falsifié. */
export function emailFromUnsubscribeToken(token: string): string | null {
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null

  const expected = Buffer.from(
    crypto.createHmac('sha256', secret()).update(payload).digest('base64url')
  )
  const received = Buffer.from(signature)

  // Longueurs différentes : `timingSafeEqual` lève au lieu de rendre `false`.
  if (expected.length !== received.length) return null
  if (!crypto.timingSafeEqual(expected, received)) return null

  const email = Buffer.from(payload, 'base64url').toString('utf8')

  return email.includes('@') ? email : null
}

/** L'URL que porte l'en-tête `List-Unsubscribe`, et le lien en pied d'e-mail. */
export function unsubscribeUrl(email: string): string {
  const base = (process.env.API_URL || 'https://api.onsignale.fr').replace(/\/$/, '')

  return `${base}/api/notifications/unsubscribe/${unsubscribeToken(email)}`
}
