-- Automatisk fördelning av Att fördela.
-- cap_amount: hinkens tak. Påfyllningar tar aldrig saldot över taket. null = inget tak.
-- overflow_rank: ordning för överskottet (1 först). Samma ordning delar lika. null = inget överskott.
-- allocations.source: 'base' = månadsbeloppet, 'overflow' = överskott. En rad av varje per hink och period.
alter table public.buckets add column if not exists cap_amount bigint check (cap_amount is null or cap_amount >= 0);
alter table public.buckets add column if not exists overflow_rank int check (overflow_rank is null or overflow_rank >= 1);

alter table public.allocations add column if not exists source text not null default 'base' check (source in ('base', 'overflow'));
alter table public.allocations drop constraint if exists allocations_bucket_id_period_start_key;
alter table public.allocations add constraint allocations_bucket_period_source_key unique (bucket_id, period_start, source);
