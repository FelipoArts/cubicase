-- ============================================================
-- Perfil do jogador (Fase 1 do plans/player-profile-plan.md)
-- ============================================================
-- Rodar no SQL editor do projeto Supabase (rtfxcyvymlxebvemgwaj). Seguro rodar
-- mais de uma vez.
--
-- Nada aqui é lido/escrito pelo navegador nem pelo app desktop: RLS fica LIGADO
-- e SEM policies de propósito. Só o Worker (SUPABASE_SERVICE_ROLE_KEY, que
-- bypassa RLS) mexe nesta tabela, porque é ele quem valida o nome exibido e os
-- ids de avatar/cor contra o catálogo (ver api/src/profile.ts).
--
-- O perfil é público só nos campos display_name, avatar_id e name_color. O
-- e-mail da conta nunca sai daqui.
-- ============================================================

create table if not exists public.profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 3 and 40),
  avatar_id     text not null default 'cube',
  name_color    text,
  handle        text unique,   -- reservado para uma fase futura (busca e convite por @nome)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;
