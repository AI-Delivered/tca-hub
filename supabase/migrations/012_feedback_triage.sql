-- Record what triage made of each reported bug, so nobody re-reads a closed one.
--
-- query_feedback has been collecting reports from parents — the only signal in
-- this app that can see a confident wrong answer — and nothing consumed them. The
-- triage cron asks each reported question again, evaluates the answer against the
-- checks that can be settled in code, and writes its verdict back here.
--
-- Three columns, and the important one is `triaged_at`: without it every run
-- re-evaluates the whole table, which costs a generation per report per day and
-- makes the "needs a human" list grow rather than shrink.
alter table query_feedback add column if not exists triaged_at timestamptz;
alter table query_feedback add column if not exists verdict text;
alter table query_feedback add column if not exists verdict_detail jsonb;

-- The working query is "what has arrived that nobody has looked at", so that is
-- what gets the index.
create index if not exists query_feedback_untriaged_idx
  on query_feedback (created_at desc)
  where triaged_at is null;
