-- L'app Mac envoie aussi le transcript (fait sur le Mac) avec l'enregistrement.
-- La clé publique peut toujours seulement AJOUTER une ligne, jamais lire ni modifier.
grant insert (transcript_text, transcript_json, language, provider) on public.calls to anon;

drop policy if exists "anon peut ajouter un appel" on public.calls;
create policy "anon peut ajouter un appel"
  on public.calls for insert to anon
  with check (status in ('uploaded', 'transcribed') and summary is null);
