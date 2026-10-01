-- ══════════════════════════════════════════════════════════════════════════
-- Cargo "somente visualização"
--
-- Antes: qualquer usuário logado lia e gravava em public.documentos.
-- Agora: todos os logados continuam lendo; só grava quem NÃO está num cargo
-- marcado como somente visualização.
--
-- O cargo do usuário é achado como no app (supabase-firestore.js):
--   perfil = documento de "usuarios" com o id do login ou com o mesmo e-mail
--            (preferindo o ativo); o cargo é o documento de "cargos" com o
--            cargoId do perfil. O cargo padrão "c4" (Visualizador) vale como
--            somente visualização mesmo sem documento gravado.
--
-- Rode inteiro no SQL Editor do Supabase. Está numa transação: se alguma parte
-- falhar, nada muda. Pode rodar mais de uma vez.
-- Para desfazer, rode o bloco comentado no fim do arquivo.
-- ══════════════════════════════════════════════════════════════════════════
begin;

create or replace function public.fs_somente_leitura()
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
             when c.id is not null then coalesce(c.dados->'somenteLeitura' = 'true'::jsonb, false)
             else u.dados->>'cargoId' = 'c4'
           end
      from public.documentos u
      left join public.documentos c
             on c.colecao = 'cargos' and c.id = u.dados->>'cargoId'
     where u.colecao = 'usuarios'
       and ( u.id = (select auth.uid())::text
          or lower(trim(u.dados->>'email')) = lower(trim((select auth.jwt())->>'email')) )
     order by (u.id = (select auth.uid())::text) desc,   -- perfil com o id do login primeiro
              (u.dados->'ativo' = 'false'::jsonb),        -- depois os ativos
              u.id collate "C"
     limit 1
  ), false);
$$;

comment on function public.fs_somente_leitura() is
  'true quando o usuário logado está num cargo somente visualização (GestãoRotas).';

revoke all on function public.fs_somente_leitura() from public, anon;
grant execute on function public.fs_somente_leitura() to authenticated, service_role;

-- Leitura para todos os logados; gravação só para quem não é somente visualização
drop policy if exists documentos_autenticados on public.documentos;
drop policy if exists documentos_ler      on public.documentos;
drop policy if exists documentos_inserir  on public.documentos;
drop policy if exists documentos_alterar  on public.documentos;
drop policy if exists documentos_apagar   on public.documentos;

create policy documentos_ler on public.documentos
  for select to authenticated using (true);

create policy documentos_inserir on public.documentos
  for insert to authenticated
  with check (not (select public.fs_somente_leitura()));

create policy documentos_alterar on public.documentos
  for update to authenticated
  using (not (select public.fs_somente_leitura()))
  with check (not (select public.fs_somente_leitura()));

create policy documentos_apagar on public.documentos
  for delete to authenticated
  using (not (select public.fs_somente_leitura()));

commit;

-- ── Para desfazer (volta ao comportamento anterior: todo logado lê e grava) ──
-- begin;
-- drop policy if exists documentos_ler      on public.documentos;
-- drop policy if exists documentos_inserir  on public.documentos;
-- drop policy if exists documentos_alterar  on public.documentos;
-- drop policy if exists documentos_apagar   on public.documentos;
-- drop policy if exists documentos_autenticados on public.documentos;
-- create policy documentos_autenticados on public.documentos
--   for all to authenticated using (true) with check (true);
-- commit;
