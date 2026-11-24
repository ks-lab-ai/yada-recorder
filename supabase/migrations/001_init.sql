-- Yada Recorder : schéma initial
-- Table calls + recherche plein texte (FR/EN, sans accents) + bucket privé call-recordings.
-- Sécurité : RLS activée sans aucune policy. Seule la clé secrète (service_role)
-- utilisée par l'app desktop peut lire ou écrire. La clé publique (anon) ne voit rien.

create extension if not exists unaccent with schema extensions;

-- unaccent() n'est pas IMMUTABLE, il faut un wrapper pour l'utiliser dans une colonne générée.
create or replace function public.f_unaccent(text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, $1) $$;

create table if not exists public.calls (
  id              uuid primary key,
  started_at      timestamptz not null,
  ended_at        timestamptz,
  duration        integer,                         -- secondes
  phone_number    text,
  contact_name    text,
  direction       text not null default 'unknown'
                  check (direction in ('outbound', 'inbound', 'unknown')),
  audio_path      text,                            -- chemin dans le bucket call-recordings
  transcript_json jsonb,                           -- { language, provider, segments: [{ speaker, start, end, text }] }
  transcript_text text,                            -- "[00:12] Moi : ..." une ligne par segment
  summary         text,                            -- markdown : résumé + next steps
  status          text not null default 'processing'
                  check (status in ('processing', 'uploaded', 'transcribed', 'done', 'empty', 'error')),
  error           text,
  language        text,
  provider        text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  fts             tsvector generated always as (
                    to_tsvector('simple', public.f_unaccent(
                      coalesce(contact_name, '') || ' ' ||
                      coalesce(phone_number, '') || ' ' ||
                      coalesce(summary, '') || ' ' ||
                      coalesce(transcript_text, '')
                    ))
                  ) stored
);

create index if not exists calls_started_at_idx on public.calls (started_at desc);
create index if not exists calls_fts_idx on public.calls using gin (fts);

create or replace function public.calls_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists calls_touch_updated_at on public.calls;
create trigger calls_touch_updated_at
  before update on public.calls
  for each row execute function public.calls_touch_updated_at();

alter table public.calls enable row level security;
revoke all on public.calls from anon, authenticated;

-- Recherche : plein texte sur transcript + résumé + contact, ou sous-chaîne du numéro.
create or replace function public.search_calls(q text default null, lim integer default 200, off integer default 0)
returns setof public.calls
language sql
stable
security invoker
set search_path = ''
as $$
  select c.*
  from public.calls c
  where q is null
     or btrim(q) = ''
     or c.fts @@ websearch_to_tsquery('simple', public.f_unaccent(q))
     or (q ~ '^[\s\d+().-]+$'
         and regexp_replace(coalesce(c.phone_number, ''), '\D', '', 'g') like '%' || regexp_replace(q, '\D', '', 'g') || '%')
     or public.f_unaccent(coalesce(c.contact_name, '')) ilike '%' || public.f_unaccent(btrim(q)) || '%'
  order by c.started_at desc
  limit lim offset off
$$;

revoke execute on function public.search_calls(text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_calls(text, integer, integer) to service_role;

-- Bucket privé pour l'audio (50 Mo max par fichier, soit plus de 2 h d'appel en opus 48 kb/s).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('call-recordings', 'call-recordings', false, 52428800, array['audio/webm', 'audio/ogg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
-- Pas de policy sur storage.objects pour ce bucket : seul service_role y accède.
