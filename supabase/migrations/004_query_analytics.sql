-- Extend query_log with the fields needed for the admin analytics dashboard:
-- whether we found any context, how much, the model used, latency, and a
-- truncated copy of the answer so "what did we actually say" is reviewable
-- without re-running the query.
alter table query_log add column if not exists had_results boolean;
alter table query_log add column if not exists source_count integer;
alter table query_log add column if not exists top_similarity real;
alter table query_log add column if not exists model text;
alter table query_log add column if not exists latency_ms integer;
alter table query_log add column if not exists answer_preview text;
alter table query_log add column if not exists input_tokens integer;
alter table query_log add column if not exists output_tokens integer;

create index if not exists query_log_created_at_idx on query_log (created_at desc);
create index if not exists query_log_had_results_idx on query_log (had_results) where had_results = false;
