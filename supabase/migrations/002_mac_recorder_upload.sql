-- App Mac « gros bouton » : envoi direct avec la clé publique (publishable / anon).
-- La clé publique peut seulement AJOUTER : un fichier dans le bucket, une ligne dans calls.
-- Elle ne peut ni lire, ni modifier, ni supprimer quoi que ce soit (pas de policy select/update/delete).

update storage.buckets
set allowed_mime_types = array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac']
where id = 'call-recordings';

drop policy if exists "anon peut deposer des enregistrements" on storage.objects;
create policy "anon peut deposer des enregistrements"
  on storage.objects for insert to anon
  with check (bucket_id = 'call-recordings');

grant insert (id, started_at, ended_at, duration, audio_path, status, phone_number, contact_name, direction)
  on public.calls to anon;

drop policy if exists "anon peut ajouter un appel" on public.calls;
create policy "anon peut ajouter un appel"
  on public.calls for insert to anon
  with check (status = 'uploaded' and transcript_json is null and summary is null);
