-- Switch embedding column from 1536 (OpenAI) to 512 (voyage-3-lite)
alter table page_chunks alter column embedding type vector(512);

-- Recreate index for new dimensions
drop index if exists page_chunks_embedding_idx;
create index page_chunks_embedding_idx
  on page_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Recreate match function with correct dimensions
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
  order by embedding <=> query_embedding
  limit match_count;
$$;
