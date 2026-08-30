-- ------------------------------------------------------------------
-- The cloud copy: one row per user, holding the mirror file's own bytes.
--
-- `SYNC.md` Phase 2. The row is opaque: `payload` is what `src/lib/vault.ts`
-- sealed over `serialiseMirror`'s output, so this database holds a locked box
-- and a row id and nothing this schema could query. That is the whole reason
-- there is no events table here and never will be one.
-- ------------------------------------------------------------------

create table if not exists public.documents (
  user_id uuid primary key references auth.users on delete cascade,

  -- The mirror's own concurrency story, unchanged by the transport: a writer
  -- reads this, checks it is still what it read, and writes `rev + 1`. The
  -- conditional update below is what makes that check atomic — the thing a
  -- file could not offer, and the reason `mirrorLink.ts` needed a `.lock`
  -- sibling and Web Locks where this needs neither.
  rev integer not null default 0,

  -- `MIRROR_VERSION`, and it lives out here rather than inside the ciphertext
  -- because a reader has to be able to refuse a document it is too old to
  -- round-trip *before* it decrypts anything. Measured rather than feared: a
  -- stale reader writing a newer document back drops ten keys per record.
  version integer not null,

  -- The IANA zone the writer was in. Outside the ciphertext for the same
  -- reason: every day boundary in circal is deliberately local, so
  -- `zonesAgree` has to be answerable before the payload is opened.
  zone text not null default '',

  -- Ciphertext. The server never holds a plaintext calendar, so a breach here
  -- is a breach of strangers' locked boxes rather than their appointments.
  payload text not null,

  updated_at timestamptz not null default now()
);

-- Row level security is what protects the data — not the anon key, which is
-- public by design and shipped in the client bundle. Every operation is
-- scoped to the caller's own row, in both directions: `using` for what may be
-- read and updated, `with check` for what may be written.
alter table public.documents enable row level security;

create policy own_document on public.documents
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- `updated_at` means "when the row last moved", and a client-supplied
-- timestamp is a client that can be wrong about that. `default now()` covers
-- the insert and nothing covers the update, which is the whole of the row's
-- lifetime after the first write.
--
-- `search_path = ''` because a trigger function resolving names through the
-- caller's search path is the standing Supabase advisory, and this one needs
-- no schema of its own.
create or replace function public.touch_document()
  returns trigger
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger touch_document
  before update on public.documents
  for each row execute function public.touch_document();

-- Realtime, and it is deliberately not a requirement. `cloudLink.ts`
-- subscribes to this row and falls back to polling when the socket is down,
-- because a user behind a proxy that kills websockets should still sync,
-- slower. A table absent from this publication emits nothing and no error, so
-- the fallback would be the *only* path and nobody would find out from a log:
-- the membership is part of the schema for that reason.
--
-- `add table` throws where the table is already a member, which is a
-- re-applied migration rather than a problem.
do $$
begin
  alter publication supabase_realtime add table public.documents;
exception
  when duplicate_object then null;
end
$$;
