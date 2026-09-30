-- ══════════════════════════════════════════════════════════════════════════
-- GestãoRotas — armazenamento de documentos no estilo Firestore
--
-- Cada documento do Firestore vira UMA linha:
--   colecao  = caminho da coleção  (ex.: 'tecnicos', 'rotas/2026-09-29/ordens')
--   id       = id do documento
--   dados    = o documento inteiro em JSONB (todos os campos, sem perder nada)
--
-- Codificação de tipos especiais dentro de "dados":
--   {"$ts": "2026-09-29T12:00:00.123456Z"}  → Timestamp do Firestore
--   {"$serverTimestamp": true}              → serverTimestamp() (resolvido aqui no banco)
--   {"$num": "NaN" | "Infinity" | "-Infinity"}
--
-- Como aplicar: cole este arquivo inteiro no SQL Editor do Supabase e clique em Run.
-- Pode rodar mais de uma vez sem problema.
-- ══════════════════════════════════════════════════════════════════════════

create table if not exists public.documentos (
  colecao        text collate "C" not null,
  id             text collate "C" not null,
  dados          jsonb not null default '{}'::jsonb,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now(),
  primary key (colecao, id)
);

comment on table public.documentos is 'Documentos do GestãoRotas no formato Firestore (colecao/id/dados).';

-- Busca por OS / telefone / cliente (usada pelo /api/visita)
create index if not exists documentos_os_idx on public.documentos ((dados->>'os'));

-- ── Realtime (onSnapshot) ────────────────────────────────────────────────
-- replica identity full: eventos de DELETE trazem a chave (colecao,id)
alter table public.documentos replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'documentos') then
    alter publication supabase_realtime add table public.documentos;
  end if;
end $$;

-- ── Segurança: só usuários logados leem/escrevem (equivalente a request.auth != null) ──
alter table public.documentos enable row level security;
drop policy if exists documentos_autenticados on public.documentos;
create policy documentos_autenticados on public.documentos
  for all to authenticated using (true) with check (true);
revoke all on public.documentos from anon;
grant select, insert, update, delete on public.documentos to authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- Funções internas
-- ══════════════════════════════════════════════════════════════════════════

-- Troca {"$serverTimestamp": true} pela hora do servidor (igual ao Firestore)
create or replace function public.fs_resolver_ts(v jsonb, agora text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  k text; e jsonb; r jsonb;
begin
  if v is null or position('"$serverTimestamp"' in v::text) = 0 then
    return v;
  end if;
  if jsonb_typeof(v) = 'object' then
    if v = '{"$serverTimestamp": true}'::jsonb then
      return jsonb_build_object('$ts', agora);
    end if;
    r := '{}'::jsonb;
    for k, e in select * from jsonb_each(v) loop
      r := r || jsonb_build_object(k, public.fs_resolver_ts(e, agora));
    end loop;
    return r;
  elsif jsonb_typeof(v) = 'array' then
    select coalesce(jsonb_agg(public.fs_resolver_ts(x, agora) order by ord), '[]'::jsonb)
      into r from jsonb_array_elements(v) with ordinality t(x, ord);
    return r;
  end if;
  return v;
end $$;

create or replace function public.fs_agora()
returns text language sql stable set search_path = '' as $$
  select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

-- setDoc: grava/substitui o documento inteiro
create or replace function public.fs_set(p_colecao text, p_id text, p_dados jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  d jsonb := public.fs_resolver_ts(p_dados, public.fs_agora());
begin
  insert into public.documentos as t (colecao, id, dados)
  values (p_colecao, p_id, d)
  on conflict (colecao, id) do update
    set dados = excluded.dados, atualizado_em = now();
end $$;

-- updateDoc: mescla só os campos enviados; falha se o documento não existe.
-- Aceita caminhos com ponto ("a.b") e {"$delete": true} (deleteField).
-- A linha é travada (FOR UPDATE): dois usuários editando campos diferentes
-- da mesma OS ao mesmo tempo não se sobrescrevem.
create or replace function public.fs_update(p_colecao text, p_id text, p_dados jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  atual jsonb;
  patch jsonb := public.fs_resolver_ts(p_dados, public.fs_agora());
  k text; e jsonb; caminho text[]; i int;
begin
  select dados into atual from public.documentos
   where colecao = p_colecao and id = p_id for update;
  if not found then
    raise exception 'No document to update: %/%', p_colecao, p_id using errcode = 'P0002';
  end if;
  for k, e in select * from jsonb_each(patch) loop
    caminho := string_to_array(k, '.');
    for i in 1 .. coalesce(array_length(caminho, 1), 1) - 1 loop
      if jsonb_typeof(atual #> caminho[1:i]) is distinct from 'object' then
        atual := jsonb_set(atual, caminho[1:i], '{}'::jsonb, true);
      end if;
    end loop;
    if e = '{"$delete": true}'::jsonb then
      atual := atual #- caminho;
    else
      atual := jsonb_set(atual, caminho, e, true);
    end if;
  end loop;
  update public.documentos set dados = atual, atualizado_em = now()
   where colecao = p_colecao and id = p_id;
end $$;

-- deleteDoc: não falha se o documento não existe (igual ao Firestore)
create or replace function public.fs_delete(p_colecao text, p_id text)
returns void language sql set search_path = '' as $$
  delete from public.documentos where colecao = p_colecao and id = p_id;
$$;

-- writeBatch().commit(): tudo ou nada, numa única transação
-- p_ops = [{"op":"set"|"update"|"delete","colecao":"...","id":"...","dados":{...}}, ...]
create or replace function public.fs_batch(p_ops jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  o jsonb;
begin
  for o in select * from jsonb_array_elements(p_ops) loop
    case o->>'op'
      when 'set'    then perform public.fs_set(o->>'colecao', o->>'id', o->'dados');
      when 'update' then perform public.fs_update(o->>'colecao', o->>'id', o->'dados');
      when 'delete' then perform public.fs_delete(o->>'colecao', o->>'id');
      else raise exception 'Operação inválida: %', o->>'op';
    end case;
  end loop;
end $$;

revoke all on function public.fs_set(text, text, jsonb)    from public, anon;
revoke all on function public.fs_update(text, text, jsonb) from public, anon;
revoke all on function public.fs_delete(text, text)        from public, anon;
revoke all on function public.fs_batch(jsonb)              from public, anon;
grant execute on function public.fs_set(text, text, jsonb)    to authenticated, service_role;
grant execute on function public.fs_update(text, text, jsonb) to authenticated, service_role;
grant execute on function public.fs_delete(text, text)        to authenticated, service_role;
grant execute on function public.fs_batch(jsonb)              to authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- View de conveniência para relatórios em SQL (somente leitura)
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.fs_ts(v jsonb)
returns timestamptz language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(v) = 'object' and v ? '$ts' then (v->>'$ts')::timestamptz end;
$$;

create or replace view public.vw_ordens with (security_invoker = true) as
select
  case when split_part(colecao, '/', 2) ~ '^\d{4}-\d{2}-\d{2}$'
       then split_part(colecao, '/', 2)::date end as data,
  id,
  dados->>'os'                             as os,
  dados->>'status'                         as status,
  dados->>'techId'                         as tech_id,
  dados->>'tipo'                           as tipo,
  dados->>'periodo'                        as periodo,
  dados->>'prio'                           as prio,
  dados->>'nome_cliente'                   as nome_cliente,
  dados->>'tel'                            as tel,
  dados->>'endereco'                       as endereco,
  dados->>'bairro'                         as bairro,
  dados->>'modelo'                         as modelo,
  dados->>'defeito'                        as defeito,
  dados->>'solucao'                        as solucao,
  dados->>'ftc'                            as ftc,
  dados->>'valor'                          as valor,
  dados->>'posicao'                        as posicao,
  public.fs_ts(dados->'createdAt')         as criado_em,
  public.fs_ts(dados->'finalizadoEm')      as finalizado_em,
  dados
from public.documentos
where colecao like 'rotas/%/ordens';
