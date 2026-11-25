-- Automatisk fördelning går att slå av och på. Av från början: hushållet fördelar lönen för hand.
alter table public.settings add column if not exists auto_allocate boolean not null default false;

-- Bara den automatiska fördelningen skriver till allocations (för hand används transfers).
-- När den är avslagen hoppas skrivningarna tyst över, så att en app som är öppen med
-- gammal kod inte fyller hinkarna igen.
create or replace function public.allocations_only_when_auto() returns trigger
language plpgsql as $$
begin
  if coalesce((select auto_allocate from public.settings where id = 1), false) then
    return new;
  end if;
  return null;
end;
$$;

drop trigger if exists allocations_only_when_auto on public.allocations;
create trigger allocations_only_when_auto before insert or update on public.allocations
  for each row execute function public.allocations_only_when_auto();
