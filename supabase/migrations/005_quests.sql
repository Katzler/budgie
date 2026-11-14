-- Quests: uppdrag som ger pengar till den egna privata hinken.
--
-- kind 'streak':   bocka i varje dag. Var `every_days`:e dag i rad ger `reward_amount`.
--                  En missad dag nollställer sviten. Bara idag och igår går att bocka i.
-- kind 'cooldown': på hedersord. Kan tas en gång per `every_days` dagar.
--
-- Pengarna tas från hinken i settings.quest_bucket_id och går till ägarens privata
-- hink. Det sker bara i funktionen claim_quest, som kontrollerar allt på servern:
-- appen kan inte skriva i quest_checks eller quest_claims direkt.

alter table public.settings add column if not exists quest_bucket_id uuid references public.buckets on delete set null;

create table public.quests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.members (user_id) on delete cascade,
  title text not null,
  icon text not null default '🏆',
  description text,
  kind text not null check (kind in ('streak', 'cooldown')),
  reward_amount bigint not null check (reward_amount > 0),
  every_days int not null default 7 check (every_days >= 1),
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- En rad per dag som ett streak-quest är gjort.
create table public.quest_checks (
  quest_id uuid not null references public.quests on delete cascade,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (quest_id, day)
);

-- Tagna belöningar. För streak: sviten (run_start) och dagen i sviten (milestone).
-- Ångras flytten försvinner belöningen också och kan tas igen.
create table public.quest_claims (
  id uuid primary key default gen_random_uuid(),
  quest_id uuid not null references public.quests on delete cascade,
  owner_id uuid not null references public.members (user_id) on delete cascade,
  day date not null,
  run_start date,
  milestone int,
  amount bigint not null check (amount > 0),
  transfer_id uuid references public.transfers on delete cascade,
  created_at timestamptz not null default now(),
  unique (quest_id, run_start, milestone)
);
create index quest_claims_quest_idx on public.quest_claims (quest_id, day desc);

alter table public.quests enable row level security;
alter table public.quest_checks enable row level security;
alter table public.quest_claims enable row level security;

-- Båda ser varandras framsteg. Ändringar sker bara via funktionerna nedan.
create policy "members read quests" on public.quests for select using (public.is_member());
create policy "members read quest checks" on public.quest_checks for select using (public.is_member());
create policy "members read quest claims" on public.quest_claims for select using (public.is_member());

create or replace function public.quest_today()
returns date language sql stable as $$
  select (now() at time zone 'Europe/Stockholm')::date
$$;

/** Hämtar ett aktivt quest som ägs av den inloggade, annars fel. */
create or replace function public.own_quest(p_quest uuid)
returns public.quests
language plpgsql stable security definer
set search_path = public
as $$
declare
  q public.quests;
begin
  select * into q from quests where id = p_quest and not archived;
  if q.id is null then raise exception 'Questet finns inte'; end if;
  if q.owner_id is distinct from auth.uid() then raise exception 'Det är inte ditt quest'; end if;
  return q;
end $$;

/** Bockar i eller ur en dag i ett streak-quest. Bara idag och igår. */
create or replace function public.set_quest_check(p_quest uuid, p_day date, p_done boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  q public.quests := own_quest(p_quest);
  today date := quest_today();
begin
  if q.kind <> 'streak' then raise exception 'Det här questet bockas inte i per dag'; end if;
  if p_day not in (today, today - 1) then raise exception 'Du kan bara bocka i idag eller igår'; end if;
  perform pg_advisory_xact_lock(hashtext(q.id::text));
  if p_done then
    insert into quest_checks (quest_id, day) values (q.id, p_day) on conflict do nothing;
  else
    if exists (
      select 1 from quest_claims c
      where c.quest_id = q.id and p_day between c.run_start and c.run_start + c.milestone - 1
    ) then
      raise exception 'Dagen ingår i en belöning du redan har tagit';
    end if;
    delete from quest_checks where quest_id = q.id and day = p_day;
  end if;
end $$;

/** Saldot i en hink, räknat som computeBudget i budget.js. */
create or replace function public.bucket_balance(p_bucket uuid)
returns bigint
language sql stable security definer
set search_path = public
as $$
  select
    coalesce((select sum(amount) from allocations where bucket_id = p_bucket and period_start <= quest_today()), 0)
    + coalesce((select sum(amount) from transfers where to_bucket = p_bucket), 0)
    - coalesce((select sum(amount) from transfers where from_bucket = p_bucket), 0)
    + coalesce((
        select sum(t.amount) from transactions t
        left join bank_connections c on c.id = t.connection_id
        where t.bucket_id = p_bucket and t.kind = 'expense'
          and coalesce(c.enabled, true)
          and t.date >= coalesce((select start_date from settings where id = 1), '-infinity'::date)
      ), 0)
$$;

/**
 * Tar belöningen för ett quest om den är intjänad: flyttar pengar från
 * Quests-hinken till ägarens privata hink och sparar belöningen.
 */
create or replace function public.claim_quest(p_quest uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  q public.quests := own_quest(p_quest);
  today date := quest_today();
  source uuid;
  target public.buckets;
  last_day date;
  run_starts date[];
  milestones int[];
  earned int;
  total bigint;
  tid uuid;
begin
  perform pg_advisory_xact_lock(hashtext(q.id::text));

  select quest_bucket_id into source from settings where id = 1;
  if source is null or not exists (select 1 from buckets where id = source and not archived) then
    raise exception 'Det finns ingen Quests-hink än';
  end if;
  select * into target from buckets
    where kind = 'personal' and owner_id = auth.uid() and not archived and id <> source
    order by sort_order, name limit 1;
  if target.id is null then raise exception 'Du har ingen egen hink att ta pengarna till'; end if;

  if q.kind = 'cooldown' then
    select max(day) into last_day from quest_claims where quest_id = q.id;
    if last_day is not null and today < last_day + q.every_days then
      raise exception 'Nya pengar kan tas om % %', (last_day + q.every_days) - today,
        case when (last_day + q.every_days) - today = 1 then 'dag' else 'dagar' end;
    end if;
    run_starts := array[null::date];
    milestones := array[null::int];
  else
    -- Svitar = dagar i följd. Var every_days:e dag i en svit är en belöning.
    with g as (
      select day, day - (row_number() over (order by day))::int as grp from quest_checks where quest_id = q.id
    ), runs as (
      select min(day) as run_start, count(*)::int as len from g group by grp
    )
    select array_agg(r.run_start order by r.run_start, n), array_agg(n * q.every_days order by r.run_start, n)
    into run_starts, milestones
    from runs r, generate_series(1, r.len / q.every_days) n
    where not exists (
      select 1 from quest_claims c where c.quest_id = q.id and c.run_start = r.run_start and c.milestone = n * q.every_days
    );
  end if;

  earned := coalesce(array_length(run_starts, 1), 0);
  if earned = 0 then
    raise exception 'Du har inga pengar att ta än, fortsätt %', case when q.kind = 'streak' then 'varje dag' else 'så' end;
  end if;
  total := earned * q.reward_amount;
  if bucket_balance(source) < total then
    raise exception 'Quests-hinken har inte tillräckligt med pengar just nu';
  end if;

  insert into transfers (from_bucket, to_bucket, amount, note, created_by)
    values (source, target.id, total, 'Quest: ' || q.title, auth.uid())
    returning id into tid;
  insert into quest_claims (quest_id, owner_id, day, run_start, milestone, amount, transfer_id)
    select q.id, q.owner_id, today, e.run_start, e.milestone, q.reward_amount, tid
    from unnest(run_starts, milestones) as e(run_start, milestone);

  return json_build_object('amount', total, 'bucket', target.name, 'count', earned);
end $$;

revoke execute on function public.own_quest(uuid) from public, anon;
revoke execute on function public.set_quest_check(uuid, date, boolean) from public, anon;
revoke execute on function public.claim_quest(uuid) from public, anon;
revoke execute on function public.bucket_balance(uuid) from public, anon;
grant execute on function public.set_quest_check(uuid, date, boolean) to authenticated;
grant execute on function public.claim_quest(uuid) to authenticated;

alter publication supabase_realtime add table public.quest_checks, public.quest_claims;
