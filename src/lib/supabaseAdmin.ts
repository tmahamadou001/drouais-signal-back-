import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    'Variables SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY manquantes. ' +
    'Copie server/.env.example vers server/.env et renseigne tes valeurs.'
  )
}

// Admin client — bypasses RLS, used only on the server
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})
