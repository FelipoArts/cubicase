-- ============================================================
-- Imagens de perfil (foto e banner, só Cubicase Plus) e denúncias — Etapa B do plans/player-profile-plan.md
-- ============================================================
-- Rodar no SQL editor do projeto Supabase (rtfxcyvymlxebvemgwaj), DEPOIS de scripts/supabase-profiles.sql.
-- Seguro rodar mais de uma vez.
--
-- As imagens em si ficam no R2 (bucket cubicase-profile-images); aqui só o hash do conteúdo de cada uma.
-- Só o Worker (SUPABASE_SERVICE_ROLE_KEY) lê e escreve: RLS ligado e SEM policies de propósito.
-- ============================================================

alter table public.profiles
  add column if not exists avatar_hash text check (avatar_hash is null or avatar_hash ~ '^[a-f0-9]{32}$'),
  add column if not exists banner_hash text check (banner_hash is null or banner_hash ~ '^[a-f0-9]{32}$'),
  add column if not exists images_updated_at timestamptz;   -- intervalo mínimo entre envios

-- Denúncias de perfil (imagem, nome ou bio). O dono vê e decide pelo painel /admin.
create table if not exists public.profile_reports (
  id                uuid primary key default gen_random_uuid(),
  reporter_id       uuid not null references auth.users(id) on delete cascade,
  target_id         uuid not null references auth.users(id) on delete cascade,
  server_short_code text,
  reason            text not null check (reason in ('image', 'name_or_bio', 'other')),
  note              text check (note is null or char_length(note) <= 300),
  status            text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  action            text,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);

-- Uma denúncia aberta por par (quem denuncia, quem é denunciado): evita repetir a mesma denúncia.
create unique index if not exists profile_reports_open_unique on public.profile_reports (reporter_id, target_id) where status = 'open';
create index if not exists profile_reports_status_idx on public.profile_reports (status, created_at);

alter table public.profile_reports enable row level security;
