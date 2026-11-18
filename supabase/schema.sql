-- ============================================================
-- Debout ! — schéma Supabase
-- Toute l'API passe par des fonctions RPC (security definer).
-- Les tables ne sont pas accessibles directement par le client.
-- Un compte = un jeton secret aléatoire stocké sur le téléphone.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- Tables ----------

create table if not exists public.users (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text unique not null,
  pseudo      text not null check (char_length(pseudo) between 1 and 24),
  emoji       text not null default '😴' check (char_length(emoji) <= 16),
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

create table if not exists public.bands (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 40),
  code        text unique not null,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.band_members (
  band_id    uuid not null references public.bands(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (band_id, user_id)
);
create index if not exists band_members_user_idx on public.band_members(user_id);

create table if not exists public.alarms (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  time        text not null check (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  days        int[] not null check (cardinality(days) between 1 and 7 and days <@ array[1,2,3,4,5,6,7]),
  enabled     boolean not null default true,
  label       text not null default '' check (char_length(label) <= 30),
  sound       text not null default 'classique' check (char_length(sound) <= 30),
  challenge   text not null default 'none' check (challenge in ('none','taps','maths','phrase','hold','memory')),
  tz          text not null default 'Europe/Paris',
  created_at  timestamptz not null default now()
);
create index if not exists alarms_user_idx on public.alarms(user_id);

-- kind : trap = réveil d'un pote piégé ; surprise = réveil à une heure choisie par le pote ;
--        snooze = rappel après un snooze (sert aux notifications)
create table if not exists public.wakeups (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('trap','surprise','snooze')),
  sender_id   uuid not null references public.users(id) on delete cascade,
  target_id   uuid not null references public.users(id) on delete cascade,
  alarm_id    uuid references public.alarms(id) on delete cascade,
  fire_at     timestamptz not null,
  sound       text not null default 'classique' check (char_length(sound) <= 30),
  message     text not null default '' check (char_length(message) <= 160),
  voice       text check (voice is null or char_length(voice) <= 900000),
  challenge   text not null default 'none' check (challenge in ('none','taps','maths','phrase','hold','memory')),
  weekly      text,
  status      text not null default 'pending' check (status in ('pending','done','missed','cancelled')),
  created_at  timestamptz not null default now()
);
create index if not exists wakeups_target_idx on public.wakeups(target_id, fire_at);
create index if not exists wakeups_sender_idx on public.wakeups(sender_id, fire_at);
create unique index if not exists wakeups_one_trap_per_sender
  on public.wakeups(sender_id, alarm_id, fire_at) where kind = 'trap' and status = 'pending';

create table if not exists public.events (
  id            bigserial primary key,
  actor_id      uuid references public.users(id) on delete cascade,
  target_id     uuid references public.users(id) on delete cascade,
  type          text not null,
  data          jsonb not null default '{}'::jsonb,
  hidden_until  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists events_created_idx on public.events(created_at desc);

create table if not exists public.push_subs (
  endpoint    text primary key,
  user_id     uuid not null references public.users(id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.push_log (
  key         text primary key,
  created_at  timestamptz not null default now()
);

create table if not exists public.app_secrets (
  name   text primary key,
  value  text not null
);

-- Verrouillage : RLS activé sans aucune policy => aucun accès direct.
alter table public.users        enable row level security;
alter table public.bands        enable row level security;
alter table public.band_members enable row level security;
alter table public.alarms       enable row level security;
alter table public.wakeups      enable row level security;
alter table public.events       enable row level security;
alter table public.push_subs    enable row level security;
alter table public.push_log     enable row level security;
alter table public.app_secrets  enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------- Helpers internes ----------

create or replace function public._hash(p_token text) returns text
language sql immutable as $$
  select encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
$$;

create or replace function public._uid(p_token text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid;
begin
  if p_token is null or char_length(p_token) < 32 then
    raise exception 'AUTH' using errcode = 'P0001';
  end if;
  update users set last_seen = now() where token_hash = _hash(p_token) returning id into v;
  if v is null then
    raise exception 'AUTH' using errcode = 'P0001';
  end if;
  return v;
end $$;

create or replace function public._mates(p_uid uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct bm2.user_id
  from band_members bm1
  join band_members bm2 on bm2.band_id = bm1.band_id
  where bm1.user_id = p_uid
$$;

create or replace function public._user_json(p_uid uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'pseudo', pseudo, 'emoji', emoji) from users where id = p_uid
$$;

create or replace function public._new_code() returns text
language plpgsql as $$
declare
  chars text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  c text;
begin
  loop
    c := '';
    for i in 1..6 loop
      c := c || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.bands where code = c);
  end loop;
  return c;
end $$;

-- ---------- Comptes ----------

create or replace function public.register(p_token text, p_pseudo text, p_emoji text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid;
begin
  if p_token is null or char_length(p_token) < 32 then
    raise exception 'AUTH';
  end if;
  insert into users(token_hash, pseudo, emoji)
  values (_hash(p_token), left(trim(p_pseudo), 24), coalesce(nullif(p_emoji,''), '😴'))
  on conflict (token_hash) do update set pseudo = excluded.pseudo, emoji = excluded.emoji
  returning id into v;
  return _user_json(v);
end $$;

create or replace function public.update_profile(p_token text, p_pseudo text, p_emoji text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token);
begin
  update users set pseudo = left(trim(p_pseudo), 24), emoji = coalesce(nullif(p_emoji,''), emoji) where id = v;
  return _user_json(v);
end $$;

create or replace function public.whoami(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  return _user_json(_uid(p_token));
end $$;

create or replace function public.delete_account(p_token text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token);
begin
  delete from users where id = v;
  return true;
end $$;

-- ---------- Bandes ----------

create or replace function public.create_band(p_token text, p_name text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token); b bands;
begin
  if (select count(*) from band_members where user_id = v) >= 10 then
    raise exception 'TOO_MANY_BANDS';
  end if;
  insert into bands(name, code, created_by) values (left(trim(p_name), 40), _new_code(), v) returning * into b;
  insert into band_members(band_id, user_id) values (b.id, v);
  return jsonb_build_object('id', b.id, 'name', b.name, 'code', b.code);
end $$;

create or replace function public.join_band(p_token text, p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token); b bands;
begin
  select * into b from bands where code = upper(trim(p_code));
  if b.id is null then
    raise exception 'BAND_NOT_FOUND';
  end if;
  if not exists (select 1 from band_members where band_id = b.id and user_id = v) then
    if (select count(*) from band_members where band_id = b.id) >= 30 then
      raise exception 'BAND_FULL';
    end if;
    insert into band_members(band_id, user_id) values (b.id, v);
    insert into events(actor_id, type, data) values (v, 'joined', jsonb_build_object('band', b.name, 'band_id', b.id));
  end if;
  return jsonb_build_object('id', b.id, 'name', b.name, 'code', b.code);
end $$;

create or replace function public.leave_band(p_token text, p_band_id uuid)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token);
begin
  delete from band_members where band_id = p_band_id and user_id = v;
  delete from bands b where b.id = p_band_id and not exists (select 1 from band_members m where m.band_id = b.id);
  return true;
end $$;

-- ---------- Réveils (les miens) ----------

create or replace function public.save_alarm(
  p_token text, p_id uuid, p_time text, p_days int[], p_enabled boolean,
  p_label text, p_sound text, p_challenge text, p_tz text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token); a alarms;
begin
  if p_id is null then
    if (select count(*) from alarms where user_id = v) >= 12 then
      raise exception 'TOO_MANY_ALARMS';
    end if;
    insert into alarms(user_id, time, days, enabled, label, sound, challenge, tz)
    values (v, p_time, p_days, coalesce(p_enabled, true), coalesce(p_label,''), coalesce(p_sound,'classique'),
            coalesce(p_challenge,'none'), coalesce(nullif(p_tz,''),'Europe/Paris'))
    returning * into a;
  else
    update alarms set time = p_time, days = p_days, enabled = coalesce(p_enabled, true),
      label = coalesce(p_label,''), sound = coalesce(p_sound,'classique'),
      challenge = coalesce(p_challenge,'none'), tz = coalesce(nullif(p_tz,''), tz)
    where id = p_id and user_id = v
    returning * into a;
    if a.id is null then raise exception 'NOT_FOUND'; end if;
    -- si l'heure a changé, les pièges en attente sur cet horaire tombent à l'eau
    update wakeups set status = 'cancelled'
    where alarm_id = a.id and status = 'pending' and kind = 'trap'
      and (to_char(fire_at at time zone a.tz, 'HH24:MI') <> a.time
           or not (extract(isodow from fire_at at time zone a.tz)::int = any(a.days))
           or not a.enabled);
  end if;
  return to_jsonb(a) - 'user_id' - 'created_at';
end $$;

create or replace function public.delete_alarm(p_token text, p_id uuid)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token);
begin
  delete from alarms where id = p_id and user_id = v;
  return true;
end $$;

-- ---------- État complet pour l'appli ----------

create or replace function public.get_state(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token); res jsonb;
begin
  -- ménage : réveils passés depuis longtemps
  update wakeups set status = 'missed'
  where status = 'pending' and fire_at < now() - interval '3 hours' and (target_id = v or sender_id = v);
  update wakeups set voice = null
  where voice is not null and status <> 'pending' and fire_at < now() - interval '2 days' and (target_id = v or sender_id = v);

  select jsonb_build_object(
    'me', _user_json(v),
    'server_time', now(),
    'bands', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'name', b.name, 'code', b.code,
        'members', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', u.id, 'pseudo', u.pseudo, 'emoji', u.emoji, 'last_seen', u.last_seen,
            'alarms', (select coalesce(jsonb_agg(jsonb_build_object(
                          'id', a.id, 'time', a.time, 'days', a.days, 'label', a.label, 'tz', a.tz)
                          order by a.time), '[]'::jsonb)
                       from alarms a where a.user_id = u.id and a.enabled)
          ) order by (u.id = v) desc, u.pseudo), '[]'::jsonb)
          from band_members m join users u on u.id = m.user_id
          where m.band_id = b.id
        )
      ) order by b.created_at)
      from bands b join band_members bm on bm.band_id = b.id and bm.user_id = v
    ), '[]'::jsonb),
    'alarms', coalesce((
      select jsonb_agg(to_jsonb(a) - 'user_id' - 'created_at' order by a.time)
      from alarms a where a.user_id = v
    ), '[]'::jsonb),
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', w.id, 'kind', w.kind, 'alarm_id', w.alarm_id, 'fire_at', w.fire_at,
        'sound', w.sound, 'message', w.message, 'has_voice', w.voice is not null,
        'challenge', w.challenge, 'weekly', w.weekly,
        'sender', _user_json(w.sender_id)
      ) order by w.fire_at, w.created_at)
      from wakeups w
      where w.target_id = v and w.status = 'pending' and w.fire_at > now() - interval '3 hours'
    ), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', w.id, 'kind', w.kind, 'alarm_id', w.alarm_id, 'fire_at', w.fire_at,
        'sound', w.sound, 'message', w.message, 'has_voice', w.voice is not null,
        'challenge', w.challenge, 'weekly', w.weekly,
        'target', _user_json(w.target_id)
      ) order by w.fire_at)
      from wakeups w
      where w.sender_id = v and w.kind <> 'snooze' and w.status = 'pending' and w.fire_at > now() - interval '10 minutes'
    ), '[]'::jsonb),
    'has_push', exists (select 1 from push_subs where user_id = v)
  ) into res;
  return res;
end $$;

create or replace function public.get_voice(p_token text, p_wakeup_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token); r text;
begin
  select voice into r from wakeups where id = p_wakeup_id and (target_id = v or sender_id = v);
  return r;
end $$;

-- ---------- Envoyer un réveil à un pote ----------

create or replace function public.send_wakeup(
  p_token text, p_target uuid, p_kind text, p_alarm_id uuid, p_fire_at timestamptz,
  p_sound text, p_message text, p_voice text, p_challenge text, p_weekly text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v uuid := _uid(p_token);
  a alarms;
  w wakeups;
begin
  if p_kind not in ('trap','surprise') then raise exception 'BAD_KIND'; end if;
  if p_target = v then raise exception 'NOT_YOURSELF'; end if;
  if not exists (select 1 from _mates(v) m where m = p_target) then
    raise exception 'NOT_A_MATE';
  end if;
  if p_fire_at < now() - interval '1 minute' or p_fire_at > now() + interval '8 days' then
    raise exception 'BAD_TIME';
  end if;
  if (select count(*) from wakeups where sender_id = v and target_id = p_target and status = 'pending') >= 6 then
    raise exception 'TOO_MANY_PENDING';
  end if;
  if p_voice is not null and p_voice not like 'data:audio/%' then
    raise exception 'BAD_VOICE';
  end if;

  if p_kind = 'trap' then
    select * into a from alarms where id = p_alarm_id and user_id = p_target and enabled;
    if a.id is null then raise exception 'ALARM_NOT_FOUND'; end if;
    if to_char(p_fire_at at time zone a.tz, 'HH24:MI') <> a.time
       or not (extract(isodow from p_fire_at at time zone a.tz)::int = any(a.days)) then
      raise exception 'BAD_OCCURRENCE';
    end if;
    -- un seul piège par pote et par sonnerie : on remplace l'ancien
    update wakeups set status = 'cancelled'
    where sender_id = v and alarm_id = a.id and fire_at = p_fire_at and status = 'pending' and kind = 'trap';
  else
    p_alarm_id := null;
  end if;

  insert into wakeups(kind, sender_id, target_id, alarm_id, fire_at, sound, message, voice, challenge, weekly)
  values (p_kind, v, p_target, p_alarm_id, p_fire_at, coalesce(p_sound,'classique'),
          left(coalesce(p_message,''),160), p_voice, coalesce(p_challenge,'none'), p_weekly)
  returning * into w;

  insert into events(actor_id, target_id, type, data, hidden_until)
  values (v, p_target, case when p_kind = 'trap' then 'trap_set' else 'surprise_set' end,
          jsonb_build_object('wakeup_id', w.id, 'fire_at', p_fire_at, 'weekly', p_weekly, 'voice', p_voice is not null,
                             'challenge', w.challenge),
          p_fire_at);

  return jsonb_build_object('id', w.id, 'fire_at', w.fire_at, 'kind', w.kind);
end $$;

create or replace function public.cancel_wakeup(p_token text, p_id uuid)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token);
begin
  update wakeups set status = 'cancelled', voice = null
  where id = p_id and sender_id = v and status = 'pending';
  delete from events where actor_id = v and type in ('trap_set','surprise_set')
    and data->>'wakeup_id' = p_id::text;
  return true;
end $$;

-- ---------- Quand ça sonne ----------

-- p_action : 'stop' ou 'snooze'
create or replace function public.report_ring(
  p_token text, p_wakeup_ids uuid[], p_alarm_id uuid, p_action text,
  p_seconds int, p_snoozes int, p_fire_at timestamptz, p_snooze_minutes int)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v uuid := _uid(p_token);
  senders jsonb;
  sid uuid;
  snooze_row wakeups;
begin
  select coalesce(jsonb_agg(distinct jsonb_build_object('id', u.id, 'pseudo', u.pseudo, 'emoji', u.emoji)), '[]'::jsonb)
    into senders
  from wakeups w join users u on u.id = w.sender_id
  where w.id = any(coalesce(p_wakeup_ids, '{}')) and w.target_id = v and w.kind <> 'snooze';

  if p_action = 'stop' then
    update wakeups set status = 'done'
    where id = any(coalesce(p_wakeup_ids, '{}')) and target_id = v;
    -- coupe aussi les rappels de snooze encore en attente
    update wakeups set status = 'done'
    where target_id = v and sender_id = v and kind = 'snooze' and status = 'pending';
    insert into events(actor_id, type, data)
    values (v, 'woke', jsonb_build_object('seconds', greatest(0, coalesce(p_seconds,0)),
            'snoozes', greatest(0, coalesce(p_snoozes,0)), 'by', senders, 'fire_at', p_fire_at));
    return jsonb_build_object('ok', true, 'senders', senders);
  elsif p_action = 'snooze' then
    update wakeups set status = 'done'
    where target_id = v and sender_id = v and kind = 'snooze' and status = 'pending';
    insert into wakeups(kind, sender_id, target_id, alarm_id, fire_at, sound, message)
    values ('snooze', v, v, p_alarm_id, now() + make_interval(mins => least(15, greatest(1, coalesce(p_snooze_minutes,5)))),
            'classique', 'Fin du snooze !')
    returning * into snooze_row;
    insert into events(actor_id, type, data)
    values (v, 'snoozed', jsonb_build_object('count', coalesce(p_snoozes,1), 'by', senders));
    return jsonb_build_object('ok', true, 'snooze_id', snooze_row.id, 'fire_at', snooze_row.fire_at);
  end if;
  raise exception 'BAD_ACTION';
end $$;

create or replace function public.send_reaction(p_token text, p_target uuid, p_emoji text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token);
begin
  if not exists (select 1 from _mates(v) m where m = p_target) then raise exception 'NOT_A_MATE'; end if;
  insert into events(actor_id, target_id, type, data)
  values (v, p_target, 'reaction', jsonb_build_object('emoji', left(p_emoji, 16)));
  return true;
end $$;

-- ---------- Le fil + classement ----------

create or replace function public.get_feed(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token); res jsonb;
begin
  with mates as (select * from _mates(v) m(id) union select v)
  select jsonb_build_object(
    'events', coalesce((
      select jsonb_agg(x order by (x->>'created_at')::timestamptz desc) from (
        select jsonb_build_object(
          'id', e.id, 'type', e.type, 'data', e.data, 'created_at', e.created_at,
          'actor', _user_json(e.actor_id), 'target', _user_json(e.target_id)
        ) as x
        from events e
        where e.actor_id in (select id from mates)
          and (e.target_id is null or e.target_id in (select id from mates))
          and e.created_at > now() - interval '14 days'
          and not (e.target_id = v and e.hidden_until is not null and e.hidden_until > now())
        order by e.created_at desc
        limit 80
      ) t
    ), '[]'::jsonb),
    'stats', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user', _user_json(m.id),
        'snoozes', (select count(*) from events e where e.actor_id = m.id and e.type = 'snoozed' and e.created_at > now() - interval '30 days'),
        'wakes', (select count(*) from events e where e.actor_id = m.id and e.type = 'woke' and e.created_at > now() - interval '30 days'),
        'avg_seconds', (select round(avg((e.data->>'seconds')::numeric)) from events e where e.actor_id = m.id and e.type = 'woke' and e.created_at > now() - interval '30 days'),
        'sent', (select count(*) from wakeups w where w.sender_id = m.id and w.kind <> 'snooze' and w.status <> 'cancelled' and w.created_at > now() - interval '30 days')
      ))
      from mates m
    ), '[]'::jsonb)
  ) into res;
  return res;
end $$;

-- ---------- Notifications push ----------

create or replace function public.save_push_sub(p_token text, p_endpoint text, p_p256dh text, p_auth text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token);
begin
  insert into push_subs(endpoint, user_id, p256dh, auth) values (p_endpoint, v, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
  return true;
end $$;

create or replace function public.delete_push_sub(p_token text, p_endpoint text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token);
begin
  delete from push_subs where endpoint = p_endpoint and user_id = v;
  return true;
end $$;

-- Appelée chaque minute par la fonction Edge (rôle service uniquement).
create or replace function public.push_due()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare res jsonb;
begin
  with
  occ as (
    -- sonneries des réveils récurrents dans les 3 dernières minutes (aujourd'hui ou hier, fuseau du réveil)
    select a.id as alarm_id, a.user_id, a.time, d.day,
           ((d.day + a.time::time) at time zone a.tz) as fire_at
    from alarms a
    cross join lateral (values ((now() at time zone a.tz)::date), ((now() at time zone a.tz)::date - 1)) d(day)
    where a.enabled
      and extract(isodow from d.day)::int = any(a.days)
      and ((d.day + a.time::time) at time zone a.tz) between now() - interval '3 minutes' and now() + interval '5 seconds'
  ),
  cand as (
    select 'a:' || o.alarm_id || ':' || to_char(o.day, 'YYYY-MM-DD') as key, o.user_id,
      case when exists (select 1 from wakeups w where w.alarm_id = o.alarm_id and w.kind = 'trap' and w.status = 'pending'
                        and abs(extract(epoch from (w.fire_at - o.fire_at))) < 60)
        then '😈 Ton réveil a été piégé !'
        else '⏰ Debout ! Il est ' || o.time
      end as title,
      case when exists (select 1 from wakeups w where w.alarm_id = o.alarm_id and w.kind = 'trap' and w.status = 'pending'
                        and abs(extract(epoch from (w.fire_at - o.fire_at))) < 60)
        then (select string_agg(distinct u.pseudo, ', ') from wakeups w join users u on u.id = w.sender_id
              where w.alarm_id = o.alarm_id and w.kind = 'trap' and w.status = 'pending'
                and abs(extract(epoch from (w.fire_at - o.fire_at))) < 60) || ' t''a préparé une surprise. Ouvre vite !'
        else 'Ouvre Debout ! pour couper ton réveil.'
      end as body
    from occ o
    union all
    select 'w:' || w.id, w.target_id,
      case when w.message = 'test' then '🔔 Test réussi !'
           when w.kind = 'snooze' then '⏰ Fin du snooze !' else '📣 Réveil surprise !' end,
      case when w.message = 'test' then 'Les notifications de Debout ! marchent sur ce téléphone.'
           when w.kind = 'snooze' then 'Allez, cette fois on se lève.'
           else (select pseudo from users where id = w.sender_id) || ' a décidé que tu te levais maintenant.' end
    from wakeups w
    where w.status = 'pending' and w.kind in ('surprise','snooze')
      and w.fire_at between now() - interval '10 minutes' and now() + interval '5 seconds'
  ),
  fresh as (
    insert into push_log(key) select key from cand on conflict do nothing returning key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
    'payload', jsonb_build_object('title', c.title, 'body', c.body, 'tag', c.key,
                                  'url', './?ring=' || c.key)
  )), '[]'::jsonb) into res
  from cand c
  join fresh f on f.key = c.key
  join push_subs s on s.user_id = c.user_id;

  delete from push_log where created_at < now() - interval '3 days';
  return jsonb_build_object(
    'items', res,
    'vapid_public', (select value from app_secrets where name = 'vapid_public'),
    'vapid_private', (select value from app_secrets where name = 'vapid_private'),
    'vapid_subject', coalesce((select value from app_secrets where name = 'vapid_subject'), 'mailto:debout@example.com')
  );
end $$;

create or replace function public.push_gone(p_endpoint text)
returns boolean language sql security definer set search_path = public as $$
  delete from push_subs where endpoint = p_endpoint returning true
$$;

create or replace function public.check_tick_secret(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_secrets where name = 'tick_secret' and value = p_secret and char_length(p_secret) >= 24)
$$;

-- Envoi d'une notif de test immédiate (bouton « Tester » dans l'appli)
create or replace function public.request_test_push(p_token text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token);
begin
  insert into wakeups(kind, sender_id, target_id, fire_at, sound, message, status)
  values ('snooze', v, v, now(), 'classique', 'test', 'pending');
  return true;
end $$;

-- ---------- Droits ----------

revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.register(text, text, text),
  public.update_profile(text, text, text),
  public.whoami(text),
  public.delete_account(text),
  public.create_band(text, text),
  public.join_band(text, text),
  public.leave_band(text, uuid),
  public.save_alarm(text, uuid, text, int[], boolean, text, text, text, text),
  public.delete_alarm(text, uuid),
  public.get_state(text),
  public.get_voice(text, uuid),
  public.send_wakeup(text, uuid, text, uuid, timestamptz, text, text, text, text, text),
  public.cancel_wakeup(text, uuid),
  public.report_ring(text, uuid[], uuid, text, int, int, timestamptz, int),
  public.send_reaction(text, uuid, text),
  public.get_feed(text),
  public.save_push_sub(text, text, text, text),
  public.delete_push_sub(text, text),
  public.request_test_push(text)
to anon, authenticated;

grant execute on function public.push_due(), public.push_gone(text), public.check_tick_secret(text) to service_role;
