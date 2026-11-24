-- Qui a enregistré : prénom de la session Mac (ex. « Noé », « Louis », « Paul »).
alter table public.calls add column if not exists recorded_by text;
create index if not exists calls_recorded_by_idx on public.calls (recorded_by, started_at desc);
grant insert (recorded_by) on public.calls to anon;
