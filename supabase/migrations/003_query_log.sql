create table if not exists query_log (
  id bigserial primary key,
  query text not null,
  created_at timestamptz default now()
);

-- Allow anonymous inserts (logged from search API server-side)
-- No RLS needed since this is written server-side with service role key
