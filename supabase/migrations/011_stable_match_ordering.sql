-- Break ties in retrieval ordering, so equal-scoring chunks come back in the same
-- order every time.
--
-- `order by embedding <=> query_embedding` alone leaves the order of equally
-- distant rows to the executor, and this corpus is full of near-identical chunks:
-- 60-odd "TCA Athletics — <Sport> <Level>" documents, one supply list per grade
-- per campus, the same monthly calendar under three elementary URLs. When two of
-- them tie for the sixteenth slot, which one the model gets decides the answer,
-- and nothing in the query said which it should be. Ordering by id after distance
-- costs nothing and makes that choice repeatable.
--
-- Left alone deliberately: the index is ivfflat with lists = 100 and the default
-- ivfflat.probes = 1, so each search examines about one hundredth of the table and
-- can miss a genuine nearest neighbour — and which rows it misses changes when the
-- nightly ingest re-inserts them. That is approximate recall rather than an
-- ordering bug, the keyword anchors in the search route exist to cover it, and
-- both fixes for it are judgement calls that want measuring first on real latency:
-- raise probes (recall for time, and `set ivfflat.probes` needs the extension
-- loaded in the session), or drop the index and let a corpus of this size —
-- roughly 2,300 rows — be scanned exactly.
create or replace function match_chunks(
  query_embedding vector(512),
  match_count int default 5
)
returns table (
  id bigint,
  url text,
  title text,
  content text,
  similarity float
)
language sql stable
as $$
  select
    id,
    url,
    title,
    content,
    1 - (embedding <=> query_embedding) as similarity
  from page_chunks
  where embedding is not null
  order by embedding <=> query_embedding, id
  limit match_count;
$$;
