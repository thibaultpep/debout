-- ============================================================
-- Debout ! — notifications répétées : une par minute pendant 6 minutes,
-- tant que la personne n'a pas ouvert l'appli sur ce réveil.
-- ============================================================

create table if not exists public.ring_acks (
  user_id  uuid not null references public.users(id) on delete cascade,
  key      text not null,
  at       timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.ring_acks enable row level security;
revoke all on public.ring_acks from anon, authenticated;

-- appelée par l'appli dès que l'écran de sonnerie s'affiche
create or replace function public.ack_ring(p_token text, p_key text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token);
begin
  insert into ring_acks(user_id, key) values (v, left(p_key, 120)) on conflict do nothing;
  delete from ring_acks where at < now() - interval '3 days';
  return true;
end $$;

create or replace function public.push_due()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare res jsonb;
begin
  with
  occ as (
    select a.id as alarm_id, a.user_id, a.time, d.day,
           ((d.day + a.time::time) at time zone a.tz) as fire_at
    from alarms a
    cross join lateral (values ((now() at time zone a.tz)::date), ((now() at time zone a.tz)::date - 1)) d(day)
    where a.enabled
      and extract(isodow from d.day)::int = any(a.days)
      and ((d.day + a.time::time) at time zone a.tz) between now() - interval '6 minutes' and now() + interval '5 seconds'
  ),
  occ2 as (
    select o.*, 'a:' || o.alarm_id || ':' || to_char(o.day, 'YYYY-MM-DD') as base,
      greatest(0, floor(extract(epoch from (now() - o.fire_at)) / 60))::int as n,
      (select string_agg(distinct u.pseudo, ', ') from wakeups w join users u on u.id = w.sender_id
        where w.alarm_id = o.alarm_id and w.kind = 'trap' and w.status = 'pending'
          and abs(extract(epoch from (w.fire_at - o.fire_at))) < 60) as trappers
    from occ o
  ),
  cand as (
    select o.base, o.n, o.user_id,
      case when o.trappers is not null then '😈 Ton réveil a été piégé !' else '⏰ Debout ! Il est ' || o.time end
        || case when o.n > 0 then ' (rappel)' else '' end as title,
      case when o.trappers is not null then o.trappers || ' t''a préparé une surprise. Ouvre vite !'
           else 'Ouvre Debout ! pour couper ton réveil.' end as body
    from occ2 o
    where not exists (select 1 from ring_acks k where k.user_id = o.user_id and k.key = o.base)
    union all
    select 'w:' || w.id, greatest(0, floor(extract(epoch from (now() - w.fire_at)) / 60))::int, w.target_id,
      case when w.message = 'test' then '🔔 Test réussi !'
           when w.kind = 'snooze' then '⏰ Fin du snooze !' else '📣 Réveil surprise !' end
        || case when w.message <> 'test' and now() - w.fire_at >= interval '1 minute' then ' (rappel)' else '' end,
      case when w.message = 'test' then 'Les notifications de Debout ! marchent sur ce téléphone.'
           when w.kind = 'snooze' then 'Allez, cette fois on se lève.'
           else (select pseudo from users where id = w.sender_id) || ' a décidé que tu te levais maintenant.' end
    from wakeups w
    where w.status = 'pending' and w.kind in ('surprise','snooze')
      and w.fire_at between now() - interval '6 minutes' and now() + interval '5 seconds'
      and (w.message <> 'test' or w.fire_at > now() - interval '1 minute')
      and not exists (select 1 from ring_acks k where k.user_id = w.target_id and k.key = 'w:' || w.id)
  ),
  fresh as (
    insert into push_log(key) select base || '#' || n from cand on conflict do nothing returning key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
    'payload', jsonb_build_object('title', c.title, 'body', c.body, 'tag', c.base || '#' || c.n, 'key', c.base,
                                  'url', './?ring=' || c.base)
  )), '[]'::jsonb) into res
  from cand c
  join fresh f on f.key = c.base || '#' || c.n
  join push_subs s on s.user_id = c.user_id;

  delete from push_log where created_at < now() - interval '3 days';
  return jsonb_build_object(
    'items', res,
    'vapid_public', (select value from app_secrets where name = 'vapid_public'),
    'vapid_private', (select value from app_secrets where name = 'vapid_private'),
    'vapid_subject', coalesce((select value from app_secrets where name = 'vapid_subject'), 'mailto:debout@example.com')
  );
end $$;

revoke all on function public.ack_ring(text, text) from public, authenticated;
grant execute on function public.ack_ring(text, text) to anon;
revoke all on function public.push_due() from public, anon, authenticated;
grant execute on function public.push_due() to service_role;
