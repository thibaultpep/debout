-- À exécuter une fois après le déploiement de la fonction push-tick.
-- Remplacer __PROJECT_REF__ et __TICK_SECRET__ (le même secret que dans app_secrets).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('debout-push-tick') where exists (select 1 from cron.job where jobname = 'debout-push-tick');
select cron.schedule(
  'debout-push-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://__PROJECT_REF__.supabase.co/functions/v1/push-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-tick-secret', '__TICK_SECRET__'),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);
