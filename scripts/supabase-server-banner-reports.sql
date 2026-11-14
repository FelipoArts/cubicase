-- Denúncias de banner de servidor (Fase "aparência do servidor").
-- Quem é membro do servidor denuncia o banner pela tela do servidor; o dono vê e decide pelo painel /admin.
-- Rode uma vez no editor SQL do Supabase. Só o Worker (service role) lê e grava: RLS ligada, sem políticas.

create table if not exists public.server_banner_reports (
  id                uuid primary key default gen_random_uuid(),
  reporter_id       uuid not null references auth.users(id) on delete cascade,
  server_short_code text not null,
  -- Qual banner foi denunciado (se o host trocar depois, a decisão do dono não atinge o banner novo).
  banner_hash       text not null check (char_length(banner_hash) = 32),
  reason            text not null check (reason in ('image', 'other')),
  note              text check (note is null or char_length(note) <= 300),
  status            text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  action            text,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);

-- Uma denúncia aberta por par (quem denuncia, servidor): evita repetir a mesma denúncia.
create unique index if not exists server_banner_reports_open_unique on public.server_banner_reports (reporter_id, server_short_code) where status = 'open';
create index if not exists server_banner_reports_status_idx on public.server_banner_reports (status, created_at);

alter table public.server_banner_reports enable row level security;
