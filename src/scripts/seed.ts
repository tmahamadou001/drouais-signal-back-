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
  
  // Zone 1 — Centre-ville (8 signalements voirie)
  {
    title: 'Chaussée dégradée',
    category: 'voirie',
    description: 'Revêtement abîmé avec plusieurs nids de poule.',
    lat: 48.7322,
    lng: 1.3664,
    address_approx: 'Rue Rotrou',
    status: 'en_attente',
  },
  {
    title: 'Affaissement de la chaussée',
    category: 'voirie',
    description: 'Affaissement visible au centre de la rue.',
    lat: 48.73225,
    lng: 1.36645,
    address_approx: 'Rue Rotrou',
    status: 'en_attente',
  },
  {
    title: 'Nid de poule dangereux',
    category: 'voirie',
    description: 'Profond nid de poule risquant d\'endommager les véhicules.',
    lat: 48.7323,
    lng: 1.3665,
    address_approx: 'Rue Rotrou',
    status: 'pris_en_charge',
  },
  {
    title: 'Fissures importantes',
    category: 'voirie',
    description: 'Plusieurs fissures traversent la chaussée.',
    lat: 48.73215,
    lng: 1.36635,
    address_approx: 'Rue Rotrou',
    status: 'en_attente',
  },
  {
    title: 'Revêtement usé',
    category: 'voirie',
    description: 'Le revêtement est très usé et glissant par temps de pluie.',
    lat: 48.7321,
    lng: 1.3663,
    address_approx: 'Place Métézeau',
    status: 'en_attente',
  },
  {
    title: 'Trou dans la chaussée',
    category: 'voirie',
    description: 'Trou de 40cm de diamètre.',
    lat: 48.73235,
    lng: 1.36655,
    address_approx: 'Rue Rotrou',
    status: 'en_attente',
  },
  {
    title: 'Dégradation après travaux',
    category: 'voirie',
    description: 'La réfection après travaux est de mauvaise qualité.',
    lat: 48.7324,
    lng: 1.3666,
    address_approx: 'Place Métézeau',
    status: 'pris_en_charge',
  },
  {
    title: 'Chaussée bosselée',
    category: 'voirie',
    description: 'Nombreuses bosses et irrégularités.',
    lat: 48.73205,
    lng: 1.36625,
    address_approx: 'Rue Rotrou',
    status: 'en_attente',
  },

  // Zone 2 — Quartier Bords de l'Eure (10 signalements)
  {
    title: 'Éclairage défaillant',
    category: 'eclairage',
    description: 'Plusieurs lampadaires ne fonctionnent plus.',
    lat: 48.7280,
    lng: 1.3720,
    address_approx: 'Quai de l\'Eure',
    status: 'en_attente',
  },
  {
    title: 'Lampadaire cassé',
    category: 'eclairage',
    description: 'Poteau d\'éclairage endommagé.',
    lat: 48.72805,
    lng: 1.37205,
    address_approx: 'Quai de l\'Eure',
    status: 'pris_en_charge',
  },
  {
    title: 'Zone sombre',
    category: 'eclairage',
    description: 'Absence totale d\'éclairage sur 50 mètres.',
    lat: 48.7281,
    lng: 1.3721,
    address_approx: 'Quai de l\'Eure',
    status: 'en_attente',
  },
  {
    title: 'Ampoule grillée',
    category: 'eclairage',
    description: 'Lampadaire éteint depuis plusieurs semaines.',
    lat: 48.72795,
    lng: 1.37195,
    address_approx: 'Quai de l\'Eure',
    status: 'en_attente',
  },
  {
    title: 'Dépôt de déchets verts',
    category: 'dechets',
    description: 'Tas de branches et feuilles non ramassées.',
    lat: 48.7279,
    lng: 1.3719,
    address_approx: 'Quai de l\'Eure',
    status: 'en_attente',
  },
  {
    title: 'Poubelles renversées',
    category: 'dechets',
    description: 'Conteneurs renversés, déchets éparpillés.',
    lat: 48.72815,
    lng: 1.37215,
    address_approx: 'Rue des Bords de l\'Eure',
    status: 'pris_en_charge',
  },
  {
    title: 'Encombrants abandonnés',
    category: 'dechets',
    description: 'Vieux meubles déposés sur le trottoir.',
    lat: 48.7282,
    lng: 1.3722,
    address_approx: 'Rue des Bords de l\'Eure',
    status: 'en_attente',
  },
  {
    title: 'Décharge sauvage',
    category: 'dechets',
    description: 'Accumulation de déchets divers.',
    lat: 48.72785,
    lng: 1.37185,
    address_approx: 'Quai de l\'Eure',
    status: 'en_attente',
  },
  {
    title: 'Éclairage intermittent',
    category: 'eclairage',
    description: 'Lampadaire qui clignote de façon aléatoire.',
    lat: 48.7283,
    lng: 1.3723,
    address_approx: 'Rue des Bords de l\'Eure',
    status: 'en_attente',
  },
  {
    title: 'Sacs poubelles éventrés',
    category: 'dechets',
    description: 'Sacs déchirés par des animaux, déchets au sol.',
    lat: 48.72775,
    lng: 1.37175,
    address_approx: 'Quai de l\'Eure',
    status: 'resolu',
  },

  // Zone 3 — Avenue du 8 Mai 1945 (7 signalements voirie)
  {
    title: 'Nid de poule profond',
    category: 'voirie',
    description: 'Trou important dans la chaussée.',
    lat: 48.7350,
    lng: 1.3590,
    address_approx: 'Avenue du 8 Mai 1945',
    status: 'en_attente',
  },
  {
    title: 'Chaussée affaissée',
    category: 'voirie',
    description: 'Affaissement visible de la route.',
    lat: 48.73505,
    lng: 1.35905,
    address_approx: 'Avenue du 8 Mai 1945',
    status: 'pris_en_charge',
  },
  {
    title: 'Revêtement dégradé',
    category: 'voirie',
    description: 'Surface très abîmée et dangereuse.',
    lat: 48.7351,
    lng: 1.3591,
    address_approx: 'Avenue du 8 Mai 1945',
    status: 'en_attente',
  },
  {
    title: 'Fissures multiples',
    category: 'voirie',
    description: 'Nombreuses fissures sur la chaussée.',
    lat: 48.73495,
    lng: 1.35895,
    address_approx: 'Avenue du 8 Mai 1945',
    status: 'en_attente',
  },
  {
    title: 'Trou après travaux',
    category: 'voirie',
    description: 'Mauvaise réfection suite à des travaux.',
    lat: 48.7349,
    lng: 1.3589,
    address_approx: 'Avenue du 8 Mai 1945',
    status: 'en_attente',
  },
  {
    title: 'Dégradation importante',
    category: 'voirie',
    description: 'État général très dégradé de la chaussée.',
    lat: 48.73515,
    lng: 1.35915,
    address_approx: 'Avenue du 8 Mai 1945',
    status: 'pris_en_charge',
  },
  {
    title: 'Bosses dangereuses',
    category: 'voirie',
    description: 'Plusieurs bosses et irrégularités.',
    lat: 48.7352,
    lng: 1.3592,
    address_approx: 'Avenue du 8 Mai 1945',
    status: 'en_attente',
  },

  // Zone 4 — Zone industrielle nord (5 signalements déchets)
  {
    title: 'Dépôt sauvage industriel',
    category: 'dechets',
    description: 'Déchets industriels abandonnés.',
    lat: 48.7400,
    lng: 1.3800,
    address_approx: 'Zone industrielle Nord',
    status: 'en_attente',
  },
  {
    title: 'Conteneurs débordants',
    category: 'dechets',
    description: 'Bennes à ordures pleines et débordantes.',
    lat: 48.74005,
    lng: 1.38005,
    address_approx: 'Zone industrielle Nord',
    status: 'en_attente',
  },
  {
    title: 'Gravats abandonnés',
    category: 'dechets',
    description: 'Tas de gravats de chantier non évacués.',
    lat: 48.7401,
    lng: 1.3801,
    address_approx: 'Zone industrielle Nord',
    status: 'pris_en_charge',
  },
  {
    title: 'Décharge illégale',
    category: 'dechets',
    description: 'Accumulation importante de déchets divers.',
    lat: 48.73995,
    lng: 1.37995,
    address_approx: 'Zone industrielle Nord',
    status: 'en_attente',
  },
  {
    title: 'Encombrants professionnels',
    category: 'dechets',
    description: 'Matériel professionnel usagé abandonné.',
    lat: 48.7399,
    lng: 1.3799,
    address_approx: 'Zone industrielle Nord',
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
