-- Bankens alla saldon från Enable Banking (typ, belopp, tidpunkt), för att kunna
-- reda ut varför bankens saldo ibland skiljer sig från budgeten.
alter table public.bank_connections add column if not exists last_balances jsonb;
