-- Schemalagd bankhämtning, 4 gånger per dygn (PSD2-gränsen när ingen använder appen).
-- Kör i Supabase → SQL Editor EFTER att edge function `api` är driftsatt.
-- Byt ut <PROJECT_REF> och <CRON_SECRET> (samma värde som secret CRON_SECRET).
--
-- Tiderna är i UTC: 05, 10, 15, 20 = 06/11/16/21 på vintern, 07/12/17/22 på sommaren.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'budgie-sync',
  '0 5,10,15,20 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/api',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body := '{"action":"sync"}'::jsonb
  );
  $$
);

-- Ta bort schemat: select cron.unschedule('budgie-sync');
-- Se körningar:    select * from cron.job_run_details order by start_time desc limit 20;
