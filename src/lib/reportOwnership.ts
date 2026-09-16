import crypto from 'crypto'
import type { Request } from 'express'

/**
 * Qui a le droit de lire le fil d'un signalement.
 *
 * Deux preuves d'appartenance, parce qu'il y a deux façons de signaler :
 *
 *  - **un compte** — `reports.user_id` porte l'identifiant de son titulaire ;
 *  - **un jeton de suivi** — un signalement déposé sans compte n'a pas de
 *    `user_id` du tout (c'est délibéré : voir `POST /api/reports`, une session
 *    anonyme Supabase n'est pas une identité), mais le serveur a remis une fois
 *    un `anonymous_token` de 64 caractères. L'application le garde sur
 *    l'appareil, l'e-mail de suivi le porte dans son lien.
 *
 * Sans la seconde, l'auteur d'un signalement sans compte ne pouvait **jamais**
 * lire les réponses de sa mairie : la comparaison portait sur un `user_id` nul,
 * et l'application mobile — anonyme par défaut — n'affichait donc aucun
 * échange. Les messages partaient bien, mais seulement par e-mail, et seulement
 * si une adresse avait été donnée.
 */

export interface OwnedReport {
  user_id: string | null
  anonymous_token?: string | null
}

/** Le jeton de suivi présenté par l'appelant, s'il y en a un. */
export function reportToken(req: Request): string | null {
  const header = req.header('X-Report-Token')
  return typeof header === 'string' && header.length > 0 ? header : null
}

/**
 * Comparaison à durée constante.
 *
 * Le jeton est un porteur de droits sur un signalement : une comparaison qui
 * s'arrête au premier caractère différent laisse deviner le jeton octet par
 * octet. `timingSafeEqual` exige des longueurs égales, d'où le test préalable.
 */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export function ownsReport(req: Request, report: OwnedReport): boolean {
  if (report.user_id && req.userId && report.user_id === req.userId) return true

  const presented = reportToken(req)
  return Boolean(presented && report.anonymous_token && sameToken(presented, report.anonymous_token))
}
