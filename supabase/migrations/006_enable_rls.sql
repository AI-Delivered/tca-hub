-- Close the public read hole on every table.
--
-- None of these tables had row level security enabled, and Supabase grants the
-- `anon` role access to the public schema by default. The anon key is designed
-- to be public — it is a NEXT_PUBLIC_ variable — so with RLS off, anyone
-- holding it could read every question a parent has ever typed into the app
-- (query_log), every visitor id (page_visits), and the whole scraped knowledge
-- base (page_chunks). Verified against production before writing this: an anon
-- GET on /rest/v1/query_log returned real rows.
--
-- The app is unaffected. Every query in the app goes through the service role
-- client in src/lib/supabase.ts, and the service role bypasses RLS. So RLS is
-- enabled with NO policies at all: the service role keeps full access, and
-- anon and authenticated get nothing. If a browser-side read is ever needed,
-- it wants its own explicit policy — not the absence of one.

alter table page_chunks  enable row level security;
alter table query_log    enable row level security;
alter table page_visits  enable row level security;

-- Belt and braces: even if RLS were turned off again by accident, the anon and
-- authenticated roles should not hold table privileges on tables that exist
-- only to serve server-side code.
revoke all on page_chunks  from anon, authenticated;
revoke all on query_log    from anon, authenticated;
revoke all on page_visits  from anon, authenticated;
