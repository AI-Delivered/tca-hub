-- Enable pgvector extension
create extension if not exists vector;

-- Table for crawled page chunks
create table if not exists page_chunks (
  id bigserial primary key,
  url text not null,
  title text,
  content text not null,
  embedding vector(1536),
  crawled_at timestamptz default now(),
  created_at timestamptz default now()
);

-- Index for fast vector similarity search
create index if not exists page_chunks_embedding_idx
  on page_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Index for URL lookups (used during re-crawl to upsert)
create index if not exists page_chunks_url_idx on page_chunks (url);

-- Match function used by the search API
create or replace function match_chunks(
  query_embedding vector(1536),
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
