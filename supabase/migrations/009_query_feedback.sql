-- Reports from parents that an answer was wrong, incomplete, or never came.
--
-- Kept in its own table rather than as a column on query_log for two reasons:
-- a report arrives seconds to minutes after the answer and matching it back to
-- a log row by hand is unreliable, and one answer can be reported more than
-- once. The question and the answer are copied in so a report is readable on
-- its own, without a join that may not find anything.

create table if not exists query_feedback (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  -- 'wrong' | 'incomplete' | 'no-answer' | 'other'. Free text rather than an
  -- enum so adding a reason later doesn't need a migration.
  reason      text not null,
  query       text,
  answer      text,
  note        text,
  -- Which build produced the answer, so a report can be tied to a deploy.
  build_id    text
);

create index if not exists query_feedback_created_at_idx
  on query_feedback (created_at desc);

alter table query_feedback enable row level security;

-- Same posture as the other tables: no anon access at all. Writes and reads
-- both go through the service role, which only the server holds.
drop policy if exists "service role manages query_feedback" on query_feedback;
create policy "service role manages query_feedback"
  on query_feedback for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
