import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY

const hasPlaceholderConfig =
  supabaseUrl?.includes('your-project-ref') ||
  supabaseKey?.includes('your-supabase') ||
  supabaseKey?.includes('your_key_here')

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey && !hasPlaceholderConfig)

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    })
  : null

export const supabaseConfigMessage =
  'Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.'
