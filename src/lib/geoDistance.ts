/**
 * La distance à vol d'oiseau entre deux positions, en mètres.
 *
 * Elle vivait dans la route des confirmations, qui en était le seul usage.
 * Le constat de réparation (migration 040) applique la même vérification, au
 * même rayon : laisser deux copies aurait garanti qu'elles divergent, et c'est
 * la mesure qui décide d'accepter ou de refuser un geste d'habitant.
 *
 * Formule de haversine sur une Terre sphérique. L'écart avec l'ellipsoïde est
 * de l'ordre de 0,3 % — sans objet à l'échelle de quelques centaines de mètres.
 */
export function distanceMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): number {
  const R = 6_371_000
  const toRadians = (value: number) => (value * Math.PI) / 180

  const dLat = toRadians(toLat - fromLat)
  const dLng = toRadians(toLng - fromLng)

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(dLng / 2) ** 2

  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}
