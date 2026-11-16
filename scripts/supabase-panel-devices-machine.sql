-- Painel web: identifica o computador de cada pareamento, para não criar um registro novo a cada
-- vez que o app perde o pareamento local (sair da conta e entrar de novo, por exemplo).
-- O app guarda um identificador próprio (arquivo machine_id na pasta de dados) e o grava aqui ao parear;
-- ao parear de novo, reaproveita a linha da mesma conta com o mesmo identificador.
-- Linhas antigas ficam com machine_id nulo (o painel tem o botão "Limpar repetidos" para elas).
-- Seguro rodar mais de uma vez.

alter table public.panel_devices add column if not exists machine_id text;

-- Um computador por conta: o mesmo identificador não se repete dentro da mesma conta.
create unique index if not exists panel_devices_user_machine_unique
  on public.panel_devices (user_id, machine_id) where machine_id is not null;
