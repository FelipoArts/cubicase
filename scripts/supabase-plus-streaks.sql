-- ============================================================
-- Badge de tempo de assinatura do Cubicase Plus (Fase 3 do plans/player-profile-plan.md)
-- ============================================================
-- Rodar no SQL editor do projeto Supabase (rtfxcyvymlxebvemgwaj). Seguro rodar
-- mais de uma vez.
--
-- Guarda, por conta, o estado da sequência de assinatura contínua. O nível do
-- badge (Madeira → Netherite) é calculado na LEITURA a partir disto
-- (api/src/plus-tier.ts); não há rotina que promova níveis.
--
-- Só o Worker escreve (SUPABASE_SERVICE_ROLE_KEY), a partir dos webhooks do
-- Stripe. RLS ligado e SEM policies de propósito: nem o app nem o navegador
-- leem esta tabela direto; o Worker devolve só o nível já calculado.
-- ============================================================

create table if not exists public.plus_streaks (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  streak_started   timestamptz not null,            -- início da sequência atual (informativo)
  counted_ms       bigint not null default 0,       -- tempo ativo já fechado, sem contar buracos
  segment_start    timestamptz not null,            -- início do trecho contínuo em andamento
  last_active_end  timestamptz not null,            -- até quando o último pagamento cobre
  updated_at       timestamptz not null default now()
);

alter table public.plus_streaks enable row level security;

-- Quem já assina hoje começa a contar pela data em que assinou (é o que dá para saber).
-- Não sobrescreve nada que já exista.
insert into public.plus_streaks (user_id, streak_started, counted_ms, segment_start, last_active_end)
select user_id, created_at, 0, created_at, current_period_end
from public.subscriptions
where status in ('active', 'trialing') and current_period_end is not null
on conflict (user_id) do nothing;
