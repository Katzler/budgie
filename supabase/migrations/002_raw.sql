-- Bankens fullständiga transaktion från Enable Banking, för att kunna reda ut
-- oväntade rader (valuta, mottagare, kort, transaktionskod m.m.).
alter table public.transactions add column if not exists raw jsonb;
