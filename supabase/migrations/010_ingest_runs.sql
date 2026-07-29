-- What each ingest run actually did.
--
-- Every crawl route already computes a precise summary of its own work — pages
-- visited, chunks written, documents skipped, what it deferred and why — and
-- then returns it to whoever called it and forgets. When the caller is Vercel's
-- scheduler at 5am, nobody is there to read it, so the only evidence a run
-- happened at all was a crawled_at timestamp moving.
--
-- That gap hid a real failure: the cron jobs stopped firing entirely and the
-- app kept answering from day-old data, with no error anywhere. A run log makes
-- "did it run, and what did it change" a question with an answer.

create table if not exists ingest_runs (
  id          bigserial primary key,
  ran_at      timestamptz not null default now(),
  -- '/api/crawl', '/api/crawl/ingest-pdfs', …
  route       text not null,
  -- How it was invoked: 'cron' when Vercel's scheduler called it, otherwise
  -- 'manual'. Keeps a hand-run from looking like a healthy schedule.
  trigger     text not null default 'manual',
  duration_ms integer,
  -- Did anything land. Nullable because a route may not know.
  items       integer,
  errors      integer,
  -- The route's own return value, verbatim. Each one reports different things
  -- and freezing a shared shape here would only lose detail.
  summary     jsonb
);

create index if not exists ingest_runs_ran_at_idx on ingest_runs (ran_at desc);
create index if not exists ingest_runs_route_idx on ingest_runs (route, ran_at desc);

alter table ingest_runs enable row level security;

drop policy if exists "service role manages ingest_runs" on ingest_runs;
create policy "service role manages ingest_runs"
  on ingest_runs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
