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

const categories = ['voirie', 'eclairage', 'dechets', 'autre'] as const
const statuses = ['en_attente', 'pris_en_charge', 'resolu'] as const

const titles = {
  voirie: [
    'Nid de poule profond',
    'Chaussée dégradée',
    'Trottoir cassé',
    'Affaissement de la route',
    'Fissures importantes',
    'Bouche d\'égout sans plaque',
    'Revêtement usé',
    'Bosses dangereuses',
    'Trou après travaux',
    'Dalles soulevées'
  ],
  eclairage: [
    'Lampadaire éteint',
    'Éclairage défaillant',
    'Ampoule grillée',
    'Lampadaire penché',
    'Zone sombre',
    'Éclairage clignotant',
    'Poteau endommagé',
    'Câbles apparents',
    'Éclairage intermittent',
    'Lampadaire cassé'
  ],
  dechets: [
    'Dépôt sauvage',
    'Poubelles débordantes',
    'Encombrants abandonnés',
    'Décharge illégale',
    'Conteneurs renversés',
    'Gravats abandonnés',
    'Sacs poubelles éventrés',
    'Déchets verts non ramassés',
    'Dépôt industriel',
    'Ordures éparpillées'
  ],
  autre: [
    'Banc vandalisé',
    'Feu tricolore en panne',
    'Panneau manquant',
    'Graffiti',
    'Mobilier urbain cassé',
    'Signalisation défectueuse',
    'Barrière endommagée',
    'Abri bus dégradé',
    'Horodateur en panne',
    'Végétation envahissante'
  ]
}

const descriptions = {
  voirie: [
    'Dégradation importante de la chaussée nécessitant une intervention rapide.',
    'Surface très abîmée présentant un danger pour les usagers.',
    'État critique nécessitant une réparation urgente.',
    'Détérioration progressive causant des désagréments.',
    'Problème de revêtement à traiter rapidement.'
  ],
  eclairage: [
    'Absence d\'éclairage créant une zone d\'insécurité.',
    'Dysfonctionnement de l\'éclairage public à réparer.',
    'Problème technique nécessitant l\'intervention des services.',
    'Éclairage défectueux impactant la sécurité.',
    'Installation endommagée à remplacer.'
  ],
  dechets: [
    'Accumulation de déchets nécessitant un ramassage urgent.',
    'Dépôt illégal à évacuer rapidement.',
    'Problème de propreté à traiter.',
    'Déchets abandonnés créant une nuisance.',
    'Situation insalubre nécessitant une intervention.'
  ],
  autre: [
    'Dégradation du mobilier urbain à réparer.',
    'Problème technique nécessitant une intervention.',
    'Dysfonctionnement à corriger rapidement.',
    'Situation anormale à traiter.',
    'Problème d\'entretien à résoudre.'
  ]
}

const streets = [
  'Rue Rotrou',
  'Place Métézeau',
  'Avenue du 8 Mai 1945',
  'Boulevard Marceau',
  'Rue Saint-Pierre',
  'Rue de la Tannerie',
  'Rue Bel Air',
  'Allée des Acacias',
  'Quai de l\'Eure',
  'Rue des Bords de l\'Eure',
  'Avenue de la République',
  'Rue Victor Hugo',
  'Place de la Mairie',
  'Rue du Commerce',
  'Avenue Jean Jaurès',
  'Rue Gambetta',
  'Boulevard Louis Terrier',
  'Rue Parisis',
  'Rue Senarmont',
  'Avenue du Général de Gaulle',
  'Rue Godeau',
  'Rue de Châteaudun',
  'Rue de Vernouillet',
  'Rue Maurice Viollette',
  'Avenue de Tivoli'
]

// Centre de Dreux : 48.7322, 1.3664
// Générer des coordonnées dans un rayon de ~3km autour de Dreux
function generateCoordinates(): { lat: number; lng: number } {
  // Offset aléatoire en degrés (environ ±0.03 = ~3km)
  const latOffset = (Math.random() - 0.5) * 0.06
  const lngOffset = (Math.random() - 0.5) * 0.06
  
  return {
    lat: Math.round((48.7322 + latOffset) * 10000) / 10000,
    lng: Math.round((1.3664 + lngOffset) * 10000) / 10000
  }
}

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function generateReport() {
  const category = randomElement([...categories])
  const status = randomElement([...statuses])
  const title = randomElement(titles[category as keyof typeof titles])
  const description = randomElement(descriptions[category as keyof typeof descriptions])
  const street = randomElement(streets)
  const coords = generateCoordinates()
  
  return {
    title,
    category,
    description,
    lat: coords.lat,
    lng: coords.lng,
    address_approx: `${street}, ${Math.floor(Math.random() * 100) + 1}`,
    status
  }
}

async function seedLarge() {
  console.log('🌱 Seed large en cours (500 signalements)...')

  // Get or create test user
  const testEmail = 'citoyen@dreux-test.fr'
  let userId: string

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
  console.log('  ⏳ Suppression des données existantes...')
  await supabase.from('status_history').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await supabase.from('reports').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  console.log('  ✓ Données existantes supprimées')

  // Generate and insert 500 reports in batches
  const batchSize = 50
  const totalReports = 500
  let inserted = 0

  for (let i = 0; i < totalReports; i += batchSize) {
    const batch = []
    const batchCount = Math.min(batchSize, totalReports - i)

    for (let j = 0; j < batchCount; j++) {
      const report = generateReport()
      const daysAgo = Math.floor(Math.random() * 90) + 1
      const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()

      batch.push({
        ...report,
        photo_url: null,
        user_id: userId,
        vote_count: Math.floor(Math.random() * 20),
        created_at: createdAt,
        updated_at: createdAt,
      })
    }

    const { data: insertedReports, error: insertError } = await supabase
      .from('reports')
      .insert(batch)
      .select('id, status, created_at')

    if (insertError) {
      console.error(`  ✗ Erreur insertion batch ${i / batchSize + 1}:`, insertError.message)
      continue
    }

    // Insert status history for each report
    if (insertedReports) {
      const historyBatch = []

      for (const report of insertedReports) {
        historyBatch.push({
          report_id: report.id,
          old_status: 'en_attente',
          new_status: 'en_attente',
          changed_at: report.created_at,
        })

        if (report.status === 'pris_en_charge' || report.status === 'resolu') {
          const takenAt = new Date(new Date(report.created_at).getTime() + 2 * 24 * 60 * 60 * 1000).toISOString()
          historyBatch.push({
            report_id: report.id,
            old_status: 'en_attente',
            new_status: 'pris_en_charge',
            changed_at: takenAt,
          })
        }

        if (report.status === 'resolu') {
          const resolvedAt = new Date(new Date(report.created_at).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
          historyBatch.push({
            report_id: report.id,
            old_status: 'pris_en_charge',
            new_status: 'resolu',
            changed_at: resolvedAt,
          })
        }
      }

      await supabase.from('status_history').insert(historyBatch)
    }

    inserted += batchCount
    console.log(`  ✓ Batch ${i / batchSize + 1}/${Math.ceil(totalReports / batchSize)} : ${inserted}/${totalReports} signalements`)
  }

  console.log(`\n✅ Seed terminé : ${inserted} signalements insérés.`)
  console.log(`📊 Distribution approximative :`)
  console.log(`   - Voirie : ~${Math.round(inserted * 0.25)}`)
  console.log(`   - Éclairage : ~${Math.round(inserted * 0.25)}`)
  console.log(`   - Déchets : ~${Math.round(inserted * 0.25)}`)
  console.log(`   - Autre : ~${Math.round(inserted * 0.25)}`)
  
  process.exit(0)
}

seedLarge().catch((err) => {
  console.error('❌ Erreur fatale du seed:', err)
  process.exit(1)
})
