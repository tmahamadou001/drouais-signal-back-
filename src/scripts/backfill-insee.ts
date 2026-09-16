import 'dotenv/config'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { resolveCommune } from '../services/geoRouting.js'

/**
 * Reprise des signalements antérieurs au routage géographique.
 *
 * Avant la v2, le tenant était déclaré par le client : un signalement porte
 * donc une position mais aucun code INSEE. Ce script établit la preuve de
 * routage après coup, à partir des coordonnées déjà en base.
 *
 * Il ne **déplace jamais** un signalement d'un tenant à un autre, même si la
 * position dit le contraire. Un tel déplacement changerait le propriétaire
 * d'une donnée existante, casserait l'historique de statuts d'une mairie et
 * ferait disparaître le signalement de la liste de son auteur. Les divergences
 * sont signalées, et c'est un humain qui tranche.
 *
 *   pnpm tsx src/scripts/backfill-insee.ts           # simulation
 *   pnpm tsx src/scripts/backfill-insee.ts --write   # écriture
 */

const WRITE = process.argv.includes('--write')
const PAUSE_MS = 120 // la BAN est un service public : on ne la martèle pas

interface Row {
  id: string
  lat: number | null
  lng: number | null
  tenant_id: string
  title: string
}

async function main(): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('reports')
    .select('id, lat, lng, tenant_id, title')
    .eq('geo_resolved', false)
    .order('created_at', { ascending: true })

  if (error) throw error

  const rows = (data ?? []) as Row[]
  console.log(`${rows.length} signalement(s) à reprendre${WRITE ? '' : ' — simulation'}\n`)

  // Le territoire déclaré de chaque tenant, pour repérer les divergences.
  const { data: territories } = await supabaseAdmin
    .from('tenant_territories')
    .select('insee_code, tenant_id')
  const byTenant = new Map<string, Set<string>>()
  for (const t of territories ?? []) {
    const set = byTenant.get(t.tenant_id) ?? new Set<string>()
    set.add(t.insee_code)
    byTenant.set(t.tenant_id, set)
  }

  let resolved = 0
  let skipped = 0
  const mismatches: string[] = []

  for (const row of rows) {
    if (row.lat == null || row.lng == null) {
      console.log(`  ⨯ ${row.id}  aucune position`)
      skipped++
      continue
    }

    const commune = await resolveCommune(row.lat, row.lng)
    await new Promise((r) => setTimeout(r, PAUSE_MS))

    if (!commune) {
      console.log(`  ⨯ ${row.id}  géocodage impossible (${row.lat}, ${row.lng})`)
      skipped++
      continue
    }

    const expected = byTenant.get(row.tenant_id)
    const coherent = !expected || expected.size === 0 || expected.has(commune.inseeCode)

    if (!coherent) {
      // La position tombe hors du territoire déclaré du tenant propriétaire.
      // Le signalement est tout de même annoté — la preuve vaut mieux que rien —
      // mais la divergence remonte pour arbitrage.
      mismatches.push(
        `${row.id}  « ${row.title.slice(0, 40)} »  → ${commune.inseeCode} ${commune.communeName}`
      )
    }

    if (WRITE) {
      const { error: updateError } = await supabaseAdmin
        .from('reports')
        .update({ insee_code: commune.inseeCode, geo_resolved: true })
        .eq('id', row.id)

      if (updateError) {
        console.log(`  ⨯ ${row.id}  écriture refusée : ${updateError.message}`)
        skipped++
        continue
      }
    }

    console.log(
      `  ${coherent ? '✓' : '⚠'} ${row.id}  ${commune.inseeCode}  ${commune.communeName}`
    )
    resolved++
  }

  console.log(`\n${resolved} repris, ${skipped} ignoré(s)`)

  if (mismatches.length > 0) {
    console.log(
      `\n⚠ ${mismatches.length} signalement(s) hors du territoire déclaré de leur tenant.\n` +
      `  Le tenant n'a pas été modifié — à arbitrer à la main :\n`
    )
    mismatches.forEach((m) => console.log(`    ${m}`))
  }

  if (!WRITE) console.log('\nRelancer avec --write pour appliquer.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
