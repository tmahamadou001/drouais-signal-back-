import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('❌ Variables SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY manquantes.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

interface SeedReport {
  title: string
  category: 'voirie' | 'eclairage' | 'dechets' | 'autre'
  description: string
  lat: number
  lng: number
  address_approx: string
  status: 'en_attente' | 'pris_en_charge' | 'resolu'
}

const reports: SeedReport[] = [
  {
    title: 'Nid de poule profond',
    category: 'voirie',
    description: 'Nid de poule d\'environ 30 cm de diamètre au milieu de la chaussée. Dangereux pour les deux-roues.',
    lat: 48.7365,
    lng: 1.3635,
    address_approx: 'Rue Rotrou, face au n°23',
    status: 'en_attente',
  },
  {
    title: 'Lampadaire éteint depuis 2 semaines',
    category: 'eclairage',
    description: 'Le lampadaire côté pair ne fonctionne plus. La portion de rue est très sombre le soir.',
    lat: 48.7371,
    lng: 1.3668,
    address_approx: 'Place Métézeau',
    status: 'pris_en_charge',
  },
  {
    title: 'Dépôt sauvage d\'encombrants',
    category: 'dechets',
    description: 'Matelas, meubles et cartons abandonnés sur le trottoir depuis plusieurs jours.',
    lat: 48.7342,
    lng: 1.3621,
    address_approx: 'Avenue du 8 Mai 1945, angle rue Victor Hugo',
    status: 'en_attente',
  },
  {
    title: 'Trottoir cassé et dangereux',
    category: 'voirie',
    description: 'Dalles de trottoir soulevées par les racines d\'un arbre. Risque de chute pour les personnes âgées.',
    lat: 48.7380,
    lng: 1.3648,
    address_approx: 'Rue Saint-Pierre, devant l\'église',
    status: 'resolu',
  },
  {
    title: 'Éclairage public clignotant',
    category: 'eclairage',
    description: 'Trois lampadaires consécutifs clignotent de manière irrégulière. Gênant pour la circulation.',
    lat: 48.7358,
    lng: 1.3690,
    address_approx: 'Boulevard Marceau, secteur collège',
    status: 'en_attente',
  },
  {
    title: 'Poubelles débordantes',
    category: 'dechets',
    description: 'Les bacs de tri sont pleins et débordent. Sacs poubelles au sol attirant les nuisibles.',
    lat: 48.7348,
    lng: 1.3656,
    address_approx: 'Rue Bel Air, face à la résidence Les Acacias',
    status: 'pris_en_charge',
  },
  {
    title: 'Bouche d\'égout sans plaque',
    category: 'voirie',
    description: 'La plaque de la bouche d\'égout a disparu. Trou béant de 60 cm, très dangereux.',
    lat: 48.7375,
    lng: 1.3612,
    address_approx: 'Allée des Acacias',
    status: 'pris_en_charge',
  },
  {
    title: 'Dépôt de gravats sur la voie publique',
    category: 'dechets',
    description: 'Gravats de chantier déposés illégalement sur le trottoir. Passage piéton impossible.',
    lat: 48.7339,
    lng: 1.3642,
    address_approx: 'Rue de la Tannerie',
    status: 'en_attente',
  },
  {
    title: 'Feu tricolore en panne',
    category: 'autre',
    description: 'Le feu tricolore au croisement est bloqué au rouge clignotant depuis ce matin.',
    lat: 48.7362,
    lng: 1.3673,
    address_approx: 'Carrefour Rue Rotrou / Bd Marceau',
    status: 'resolu',
  },
  {
    title: 'Trou dans la chaussée après travaux',
    category: 'voirie',
    description: 'Suite à des travaux de canalisation, le revêtement n\'a pas été correctement refait.',
    lat: 48.7345,
    lng: 1.3600,
    address_approx: 'Rue Rotrou, côté impair',
    status: 'en_attente',
  },
  {
    title: 'Banc public vandalisé',
    category: 'autre',
    description: 'Le banc a été retourné et une latte en bois est cassée. Impossible de s\'asseoir.',
    lat: 48.7369,
    lng: 1.3655,
    address_approx: 'Place Métézeau, côté jardin',
    status: 'resolu',
  },
  {
    title: 'Lampadaire penché suite à un accident',
    category: 'eclairage',
    description: 'Un véhicule a percuté le poteau d\'éclairage qui penche dangereusement vers la route.',
    lat: 48.7352,
    lng: 1.3630,
    address_approx: 'Avenue du 8 Mai 1945, n°45',
    status: 'en_attente',
  },
]

async function seed() {
  console.log('🌱 Seed en cours…')

  // We need a user to assign reports to.
  // Create a test user if it doesn't exist.
  const testEmail = 'citoyen@dreux-test.fr'

  let userId: string

  // Try to find existing user
  const { data: existingUsers } = await supabase.auth.admin.listUsers()
  const existingUser = existingUsers?.users?.find(u => u.email === testEmail)

  if (existingUser) {
    userId = existingUser.id
    console.log(`  ✓ Utilisateur test existant: ${testEmail}`)
  } else {
    const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
      email: testEmail,
      email_confirm: true,
      user_metadata: { role: 'citizen' },
    })

    if (createError || !newUser.user) {
      console.error('❌ Impossible de créer l\'utilisateur test:', createError)
      process.exit(1)
    }

    userId = newUser.user.id
    console.log(`  ✓ Utilisateur test créé: ${testEmail}`)
  }

  // Clear existing data
  await supabase.from('status_history').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await supabase.from('reports').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  console.log('  ✓ Données existantes supprimées')

  // Insert reports
  for (const report of reports) {
    const daysAgo = Math.floor(Math.random() * 30) + 1
    const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()

    const { data: inserted, error: insertError } = await supabase
      .from('reports')
      .insert({
        ...report,
        photo_url: null,
        user_id: userId,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .select('id')
      .single()

    if (insertError) {
      console.error(`  ✗ Erreur insertion "${report.title}":`, insertError.message)
      continue
    }

    // Insert status history
    await supabase.from('status_history').insert({
      report_id: inserted.id,
      old_status: 'en_attente',
      new_status: 'en_attente',
      changed_at: createdAt,
    })

    if (report.status === 'pris_en_charge' || report.status === 'resolu') {
      const takenAt = new Date(new Date(createdAt).getTime() + 2 * 24 * 60 * 60 * 1000).toISOString()
      await supabase.from('status_history').insert({
        report_id: inserted.id,
        old_status: 'en_attente',
        new_status: 'pris_en_charge',
        changed_at: takenAt,
      })
    }

    if (report.status === 'resolu') {
      const resolvedAt = new Date(new Date(createdAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
      await supabase.from('status_history').insert({
        report_id: inserted.id,
        old_status: 'pris_en_charge',
        new_status: 'resolu',
        changed_at: resolvedAt,
      })
    }

    console.log(`  ✓ "${report.title}" (${report.status})`)
  }

  console.log(`\n✅ Seed terminé : ${reports.length} signalements insérés.`)
  process.exit(0)
}

seed().catch((err) => {
  console.error('❌ Erreur fatale du seed:', err)
  process.exit(1)
})
