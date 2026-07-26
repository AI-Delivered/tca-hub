import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// One client per warm instance rather than one per call. A single search request
// calls this up to four times — retrieval, keyword anchors, the query log — and
// each createClient() was building a fresh fetch stack and auth machinery that
// was thrown away milliseconds later.
//
// getSupabaseClient() (the anon-key client) used to live here too. Nothing
// imported it, and an unused export that hands out a browser-usable key to any
// future caller is a trap rather than a convenience — anything reaching the
// database from the browser now has to add it deliberately, and add the row
// level security policy that goes with it (supabase/migrations/006_enable_rls.sql).
let admin: SupabaseClient | null = null

export function getSupabaseAdmin(): SupabaseClient {
  if (admin) return admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
  }
  admin = createClient(url, key, {
    // Nothing here acts on behalf of a signed-in user, so skip session handling
    // entirely — it only costs work and storage lookups on every client.
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return admin
}
