-- Budgie: databasschema för Supabase.
-- Kör hela filen i Supabase → SQL Editor (eller med `supabase db push`).
--
-- Säkerhet: alla tabeller har Row Level Security. Bara användare som finns
-- i `members` kan läsa eller ändra något. Tabeller som bara edge functions
-- ska röra har inga policies alls, så de nås enbart med service role-nyckeln.

create extension if not exists pgcrypto;

-- Hushållets medlemmar ------------------------------------------------------

create table public.members (
  user_id uuid primary key references auth.users on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create or replace function public.is_member()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.members where user_id = auth.uid())
$$;

-- Inställningar (en rad) ----------------------------------------------------

create table public.settings (
  id int primary key default 1 check (id = 1),
  period_start_day int not null default 25 check (period_start_day between 1 and 28),
  start_date date,
  start_balance bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.settings default values;

-- Hinkar --------------------------------------------------------------------

create table public.buckets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  icon text not null default '🪣',
  kind text not null default 'spending' check (kind in ('spending', 'savings', 'personal')),
  owner_id uuid references public.members (user_id) on delete set null,
  monthly_amount bigint not null default 0 check (monthly_amount >= 0),
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- Påfyllning av en hink för en lönemånad.
create table public.allocations (
  id uuid primary key default gen_random_uuid(),
  bucket_id uuid not null references public.buckets on delete cascade,
  period_start date not null,
  amount bigint not null,
  unique (bucket_id, period_start)
);

-- Flytt av pengar. null betyder Att fördela.
create table public.transfers (
  id uuid primary key default gen_random_uuid(),
  from_bucket uuid references public.buckets on delete cascade,
  to_bucket uuid references public.buckets on delete cascade,
  amount bigint not null check (amount > 0),
  note text,
  created_by uuid references public.members (user_id) on delete set null,
  created_at timestamptz not null default now(),
  check (from_bucket is distinct from to_bucket)
);

-- Transaktioner ---------------------------------------------------------------
-- amount: negativt = pengar ut. kind 'expense' hör till en hink (null = osorterad),
-- kind 'income' påverkar Att fördela (lön, överföringar till sparkonto m.m.).
-- status: 'pending' = reserverad i banken, 'booked' = bokförd,
--         'manual' = inlagd för hand, 'quick' = från Apple Pay-genvägen.

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  external_id text unique,
  connection_id uuid,
  date date not null,
  amount bigint not null,
  description text not null,
  counterparty text,
  status text not null default 'manual' check (status in ('pending', 'booked', 'manual', 'quick')),
  kind text not null default 'expense' check (kind in ('expense', 'income')),
  bucket_id uuid references public.buckets on delete set null,
  categorized_by text not null default 'none' check (categorized_by in ('none', 'rule', 'user', 'quick')),
  note text,
  created_by uuid references public.members (user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index transactions_date_idx on public.transactions (date desc);
create index transactions_bucket_idx on public.transactions (bucket_id);

-- Regler för automatisk sortering.
create table public.rules (
  id uuid primary key default gen_random_uuid(),
  pattern text not null,
  kind text not null default 'expense' check (kind in ('expense', 'income')),
  bucket_id uuid references public.buckets on delete cascade,
  created_at timestamptz not null default now(),
  check (kind = 'income' or bucket_id is not null)
);

-- Bankkoppling ----------------------------------------------------------------

create table public.bank_connections (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  account_uid text not null unique,
  account_name text,
  iban text,
  enabled boolean not null default true,
  valid_until timestamptz,
  last_sync_at timestamptz,
  last_error text,
  last_balance bigint,
  last_balance_at timestamptz,
  reminded_at date,
  created_at timestamptz not null default now()
);

alter table public.transactions
  add constraint transactions_connection_fk foreign key (connection_id) references public.bank_connections on delete set null;

-- Tillfälliga state-värden under BankID-flödet. Bara för edge functions.
create table public.bank_auth_states (
  state uuid primary key,
  created_by uuid not null references public.members (user_id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Notiser och genvägar --------------------------------------------------------

create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.members (user_id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- Token för Apple Pay-genvägen. Bara SHA-256-hashen sparas.
create table public.quick_tokens (
  token_hash text primary key,
  user_id uuid not null references public.members (user_id) on delete cascade,
  label text,
  created_at timestamptz not null default now()
);

-- Row Level Security ------------------------------------------------------------

alter table public.members enable row level security;
alter table public.settings enable row level security;
alter table public.buckets enable row level security;
alter table public.allocations enable row level security;
alter table public.transfers enable row level security;
alter table public.transactions enable row level security;
alter table public.rules enable row level security;
alter table public.bank_connections enable row level security;
alter table public.bank_auth_states enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.quick_tokens enable row level security;

create policy "members read members" on public.members for select using (public.is_member());

create policy "members all settings" on public.settings for all using (public.is_member()) with check (public.is_member());
create policy "members all buckets" on public.buckets for all using (public.is_member()) with check (public.is_member());
create policy "members all allocations" on public.allocations for all using (public.is_member()) with check (public.is_member());
create policy "members all transfers" on public.transfers for all using (public.is_member()) with check (public.is_member());
create policy "members all transactions" on public.transactions for all using (public.is_member()) with check (public.is_member());
create policy "members all rules" on public.rules for all using (public.is_member()) with check (public.is_member());

-- Bankkopplingen: läsa och slå av/på, men session skapas bara av edge function.
create policy "members read bank" on public.bank_connections for select using (public.is_member());
create policy "members toggle bank" on public.bank_connections for update using (public.is_member()) with check (public.is_member());
create policy "members delete bank" on public.bank_connections for delete using (public.is_member());

create policy "own push subscriptions" on public.push_subscriptions for all
  using (user_id = auth.uid() and public.is_member())
  with check (user_id = auth.uid() and public.is_member());

create policy "own quick tokens read" on public.quick_tokens for select using (user_id = auth.uid());
create policy "own quick tokens insert" on public.quick_tokens for insert with check (user_id = auth.uid() and public.is_member());
create policy "own quick tokens delete" on public.quick_tokens for delete using (user_id = auth.uid());

-- Bara kolumnen `enabled` får ändras från appen.
revoke update on public.bank_connections from anon, authenticated;
grant update (enabled) on public.bank_connections to authenticated;

-- Håll updated_at aktuell på transaktioner.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger transactions_touch before update on public.transactions
  for each row execute function public.touch_updated_at();

-- Realtid, så att den andras ändringar syns direkt i appen.
alter publication supabase_realtime add table public.transactions, public.transfers, public.buckets, public.allocations;
