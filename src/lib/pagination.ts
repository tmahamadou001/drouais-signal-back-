/**
 * La taille de page de toute la plateforme.
 *
 * Une seule valeur, partagée par les signalements, les journaux d'audit et tout
 * ce qui pagine : trois écrans qui rendent respectivement 9, 20 et 25 lignes
 * obligent l'agent à réapprendre à chaque onglet où finit une page. 15 tient
 * dans la hauteur de table du design sans défilement interne.
 *
 * Le client peut demander autre chose, dans la limite de `MAX_PAGE_SIZE` — un
 * export, par exemple. C'est le défaut qui est commun, pas le plafond.
 */
export const DEFAULT_PAGE_SIZE = 15

/** Au-delà, la requête coûte plus cher au serveur qu'elle ne sert à l'écran. */
export const MAX_PAGE_SIZE = 100

/** Lit `?limit=` en le bornant, avec le défaut de la plateforme. */
export function readLimit(raw: unknown): number {
  const parsed = parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}
