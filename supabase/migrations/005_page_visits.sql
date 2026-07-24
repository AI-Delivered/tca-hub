-- Raw page-visit pings, separate from query_log (which only fires when someone
-- actually asks a question). Lets the admin dashboard show total site traffic
-- vs. how much of it turns into a chatbot query.
create table if not exists page_visits (
  id bigserial primary key,
  path text not null,
  referrer text,
  visitor_id text,
  created_at timestamptz default now()
);

create index if not exists page_visits_created_at_idx on page_visits (created_at desc);

-- No RLS needed — written server-side via the service role key, same as query_log.
