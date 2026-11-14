-- ============================================================
-- Membros do servidor (quem adicionou o servidor) — plans/player-profile-plan.md
-- ============================================================
-- Rodar no SQL editor do projeto Supabase (rtfxcyvymlxebvemgwaj). Seguro rodar
-- mais de uma vez.
--
-- "Membro" é uma CONTA que adicionou o servidor à biblioteca, ou o anfitrião
-- dele. Só o Worker (SUPABASE_SERVICE_ROLE_KEY) lê e escreve (api/src/members.ts):
-- RLS ligado e SEM policies de propósito. A lista só é entregue a quem também é
-- membro do servidor, e o id da conta nunca vai para o app.
-- ============================================================

create table if not exists public.server_members (
  server_short_code  text        not null,
  user_id            uuid        not null references auth.users(id) on delete cascade,
  role               text        not null default 'member' check (role in ('member', 'host')),
  created_at         timestamptz not null default now(),
  primary key (server_short_code, user_id)
);

create index if not exists server_members_user_id_idx on public.server_members (user_id);

alter table public.server_members enable row level security;
