-- Everything needed to review a single question after the fact.
--
-- 004 logged enough to *count* queries — how many failed, how slow, how much
-- they cost. It could not answer "what did we actually tell this parent, and
-- what did we tell them from?", which is the question you have when a specific
-- answer looks wrong. `answer_preview` was capped at 2000 characters and the
-- source URLs were reduced to a count before they were written down.
--
-- Three columns close that:
--   answer     — the full response, untruncated. answer_preview stays as-is so
--                nothing that reads it has to change; new writes fill both.
--   sources    — [{url, title}], the same list shown under the answer in the UI,
--                so a wrong answer can be traced to the page it came from.
--   cache_hit  — previously inferred from `model = 'cache'`, which overloaded a
--                column that should say which model ran. Recorded plainly now.

alter table query_log add column if not exists answer text;
alter table query_log add column if not exists sources jsonb;
alter table query_log add column if not exists cache_hit boolean;

-- Backfill so the explorer isn't empty-handed on existing rows: the preview IS
-- the whole answer for anything under 2000 characters, which is nearly all of
-- them. Sources can't be recovered — those rows show "not recorded".
update query_log set answer = answer_preview
  where answer is null and answer_preview is not null;

update query_log set cache_hit = (model = 'cache')
  where cache_hit is null and model is not null;

-- The explorer's search box runs ILIKE '%term%' over both the question and the
-- answer. A btree index can't serve a leading wildcard, so this is trigram.
-- pg_trgm ships with Supabase; 001 enables pgvector the same way.
create extension if not exists pg_trgm;

create index if not exists query_log_query_trgm_idx
  on query_log using gin (query gin_trgm_ops);

create index if not exists query_log_answer_trgm_idx
  on query_log using gin (answer gin_trgm_ops);

-- Sorting the explorer by "slowest" / "weakest match" over a 90-day window,
-- without these, is a full scan every time a pill is clicked.
create index if not exists query_log_latency_idx
  on query_log (latency_ms desc nulls last);

create index if not exists query_log_similarity_idx
  on query_log (top_similarity asc nulls last);
