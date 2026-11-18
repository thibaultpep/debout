-- ============================================================
-- Debout ! — renforcement de la sécurité (à appliquer après schema.sql)
--  * mot de passe d'accès commun pour créer un compte
--  * limitation des essais (mot de passe, codes de bande)
--  * le créateur d'une bande peut exclure quelqu'un et changer le code
-- Le mot de passe lui-même n'est jamais dans le code : seul son hachage bcrypt
-- est stocké, dans app_secrets (name = 'signup_password_hash').
-- ============================================================

create table if not exists public.attempts (
  id    bigserial primary key,
  kind  text not null,          -- 'signup' (par IP) ou 'join' (par compte)
  who   text not null,
  at    timestamptz not null default now()
);
create index if not exists attempts_idx on public.attempts(kind, who, at);
alter table public.attempts enable row level security;
revoke all on public.attempts from anon, authenticated;
revoke all on sequence public.attempts_id_seq from anon, authenticated;

alter function public._hash(text) set search_path = public, extensions;
alter function public._new_code() set search_path = public;

create or replace function public._client_ip() returns text
language sql stable as $$
  select coalesce(
    nullif(split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1), ''),
    current_setting('request.headers', true)::json->>'cf-connecting-ip',
    'inconnu')
$$;
alter function public._client_ip() set search_path = public;

create or replace function public._too_many(p_kind text, p_who text, p_max int) returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from attempts where kind = p_kind and who = p_who and at > now() - interval '1 hour') >= p_max
$$;

-- ---------- Inscription avec mot de passe ----------

drop function if exists public.register(text, text, text);

create or replace function public.register(p_token text, p_pseudo text, p_emoji text, p_password text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid; ip text := _client_ip(); h text; b bands;
begin
  if p_token is null or char_length(p_token) < 32 then
    raise exception 'AUTH';
  end if;
  -- un compte déjà créé avec ce jeton : simple mise à jour du profil
  if exists (select 1 from users where token_hash = _hash(p_token)) then
    update users set pseudo = left(trim(p_pseudo), 24), emoji = coalesce(nullif(p_emoji,''), emoji)
    where token_hash = _hash(p_token) returning id into v;
    return _user_json(v);
  end if;
  delete from attempts where at < now() - interval '1 day';
  if _too_many('signup', ip, 8) or _too_many('signup', '*', 200) then
    return jsonb_build_object('error', 'TOO_MANY_TRIES');
  end if;
  -- accepté : le mot de passe d'accès OU le code d'une bande existante (lien d'invitation)
  select value into h from app_secrets where name = 'signup_password_hash';
  select * into b from bands where code = upper(trim(coalesce(p_password, '')));
  if b.id is null and (h is null or p_password is null or crypt(p_password, h) <> h) then
    -- pas d'exception ici : elle annulerait l'enregistrement de l'essai raté
    insert into attempts(kind, who) values ('signup', ip), ('signup', '*');
    return jsonb_build_object('error', 'BAD_PASSWORD');
  end if;
  insert into users(token_hash, pseudo, emoji)
  values (_hash(p_token), left(trim(p_pseudo), 24), coalesce(nullif(p_emoji,''), '😴'))
  returning id into v;
  if b.id is not null and (select count(*) from band_members where band_id = b.id) < 30 then
    insert into band_members(band_id, user_id) values (b.id, v);
    insert into events(actor_id, type, data) values (v, 'joined', jsonb_build_object('band', b.name, 'band_id', b.id));
  end if;
  return _user_json(v);
end $$;

-- ---------- Rejoindre une bande : essais limités ----------

create or replace function public.join_band(p_token text, p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token); b bands;
begin
  if _too_many('join', v::text, 10) then
    return jsonb_build_object('error', 'TOO_MANY_TRIES');
  end if;
  select * into b from bands where code = upper(trim(p_code));
  if b.id is null then
    insert into attempts(kind, who) values ('join', v::text);
    return jsonb_build_object('error', 'BAND_NOT_FOUND');
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

-- ---------- Gestion de la bande par son créateur ----------

-- annule les réveils en attente entre deux personnes qui ne partagent plus aucune bande
create or replace function public._cleanup_pair(p_a uuid, p_b uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from _mates(p_a) m where m = p_b) then
    update wakeups set status = 'cancelled', voice = null
    where status = 'pending' and kind <> 'snooze'
      and ((sender_id = p_a and target_id = p_b) or (sender_id = p_b and target_id = p_a));
  end if;
end $$;

create or replace function public.leave_band(p_token text, p_band_id uuid)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token); m uuid;
begin
  delete from band_members where band_id = p_band_id and user_id = v;
  -- le plus ancien membre restant devient responsable de la bande
  update bands set created_by = (
    select user_id from band_members where band_id = p_band_id order by joined_at limit 1)
  where id = p_band_id and created_by = v;
  delete from bands b where b.id = p_band_id and not exists (select 1 from band_members bm where bm.band_id = b.id);
  for m in select user_id from band_members where band_id = p_band_id loop
    perform _cleanup_pair(v, m);
  end loop;
  return true;
end $$;

create or replace function public.kick_member(p_token text, p_band_id uuid, p_user uuid)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token); m uuid;
begin
  if not exists (select 1 from bands where id = p_band_id and created_by = v) then
    raise exception 'NOT_OWNER';
  end if;
  if p_user = v then raise exception 'NOT_YOURSELF'; end if;
  delete from band_members where band_id = p_band_id and user_id = p_user;
  for m in select user_id from band_members where band_id = p_band_id loop
    perform _cleanup_pair(p_user, m);
  end loop;
  return true;
end $$;

create or replace function public.new_band_code(p_token text, p_band_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token); b bands;
begin
  update bands set code = _new_code() where id = p_band_id and created_by = v returning * into b;
  if b.id is null then raise exception 'NOT_OWNER'; end if;
  return jsonb_build_object('id', b.id, 'name', b.name, 'code', b.code);
end $$;

-- get_state : on ajoute le responsable de chaque bande
create or replace function public.get_state(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _uid(p_token); res jsonb;
begin
  update wakeups set status = 'missed'
  where status = 'pending' and fire_at < now() - interval '3 hours' and (target_id = v or sender_id = v);
  update wakeups set voice = null
  where voice is not null and status <> 'pending' and fire_at < now() - interval '2 days' and (target_id = v or sender_id = v);

  select jsonb_build_object(
    'me', _user_json(v),
    'server_time', now(),
    'bands', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'name', b.name, 'code', b.code, 'owner_id', b.created_by,
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

-- ---------- Droits ----------
revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.register(text, text, text, text),
  public.update_profile(text, text, text),
  public.whoami(text),
  public.delete_account(text),
  public.create_band(text, text),
  public.join_band(text, text),
  public.leave_band(text, uuid),
  public.kick_member(text, uuid, uuid),
  public.new_band_code(text, uuid),
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
to anon;

grant execute on function public.push_due(), public.push_gone(text), public.check_tick_secret(text) to service_role;
