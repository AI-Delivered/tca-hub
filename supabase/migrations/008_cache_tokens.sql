-- Cache token accounting.
--
-- The search route now marks the stable half of the system prompt (and the last
-- turn of conversation history) as cacheable. That changes what `input_tokens`
-- means: it becomes the *uncached remainder* only. A request that read 2,018
-- tokens from cache reports input_tokens = 42.
--
-- Without these columns the dashboard would read that 42 and conclude the query
-- was nearly free — understating the real cost, because cached tokens are still
-- billed, just at different rates (1.25x to write an entry, 0.1x to read one).
-- Total prompt size is input + cache_creation + cache_read; pricing has to see
-- all three or the "Est. API cost" card and the credit burn-down both drift low.

alter table query_log add column if not exists cache_creation_input_tokens integer;
alter table query_log add column if not exists cache_read_input_tokens integer;
