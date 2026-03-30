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

async function clean() {
  console.log('🧹 Nettoyage de la base de données...')
  console.log('⚠️  Cette action va supprimer TOUS les signalements et leur historique.')
  console.log('')

  try {
    // Count existing reports
    const { count: reportCount } = await supabase
      .from('reports')
      .select('*', { count: 'exact', head: true })

    const { count: historyCount } = await supabase
      .from('status_history')
      .select('*', { count: 'exact', head: true })

    console.log(`📊 Données actuelles :`)
    console.log(`   - Signalements : ${reportCount || 0}`)
    console.log(`   - Historique : ${historyCount || 0}`)
    console.log('')

    if (!reportCount && !historyCount) {
      console.log('✅ La base est déjà vide.')
      process.exit(0)
    }

    // Delete status_history first (foreign key constraint)
    console.log('⏳ Suppression de l\'historique des statuts...')
    const { error: historyError } = await supabase
      .from('status_history')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000')

    if (historyError) {
      console.error('❌ Erreur suppression historique:', historyError.message)
      process.exit(1)
    }
    console.log('  ✓ Historique supprimé')

    // Delete reports
    console.log('⏳ Suppression des signalements...')
    const { error: reportsError } = await supabase
      .from('reports')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000')

    if (reportsError) {
      console.error('❌ Erreur suppression signalements:', reportsError.message)
      process.exit(1)
    }
    console.log('  ✓ Signalements supprimés')

    console.log('')
    console.log('✅ Nettoyage terminé avec succès !')
    console.log('💡 Vous pouvez maintenant lancer un seed avec :')
    console.log('   - pnpm run seed (42 signalements)')
    console.log('   - pnpm run seed:large (500 signalements)')
    
    process.exit(0)
  } catch (err) {
    console.error('❌ Erreur fatale:', err)
    process.exit(1)
  }
}

clean()
