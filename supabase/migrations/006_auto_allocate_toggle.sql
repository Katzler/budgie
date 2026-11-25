-- Automatisk fördelning går att slå av och på. Av från början: hushållet fördelar lönen för hand.
alter table public.settings add column if not exists auto_allocate boolean not null default false;
