-- ══════════════════════════════════════════════════════════════════════════
-- GestãoRotas — importa as tabelas antigas para a tabela "documentos"
--
-- A versão anterior do app gravava em tabelas separadas (ordens, tecnicos,
-- usuarios, cargos, tipos_os, auxiliares, travas, auditoria, historico_pendentes).
-- O app atual lê tudo de public.documentos. Este script copia cada linha
-- antiga para lá, no mesmo formato que o app grava:
--
--   ordens  (coluna data)  → colecao 'rotas/<data>/ordens'
--   travas  (coluna data)  → colecao 'rotas/<data>/travas'
--   demais tabelas         → colecao com o mesmo nome da tabela
--
-- Ajustes feitos em cada linha:
--   • colunas snake_case voltam ao nome que o app usa (tech_id → techId,
--     cargo_id → cargoId, finalizado_em → finalizadoEm, created_at → createdAt...)
--   • datas/horas viram Timestamp do app ({"$ts": ...})
--   • colunas vazias (null) são omitidas; "id" e senhas não entram em "dados"
--
-- Seguro para rodar mais de uma vez: NÃO sobrescreve documentos que já existem
-- em "documentos" (o que foi lançado no app novo é preservado).
-- As tabelas antigas NÃO são alteradas nem apagadas.
--
-- Como aplicar: rode antes o 20260929000000_documentos.sql; depois cole este
-- arquivo inteiro no SQL Editor do Supabase e clique em Run. O resultado
-- (quantos documentos foram importados por tabela) aparece no final.
-- ══════════════════════════════════════════════════════════════════════════

-- Converte uma linha antiga (to_jsonb) no "dados" do documento
create or replace function public.fs_importar_dados(linha jsonb, tipos jsonb, tabela text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  -- nomes de campos que o app usa em camelCase
  camel constant text[] := array['techId','tecId','tecNome','cargoId','osId',
    'createdAt','createdBy','updatedAt','updatedBy','finalizadoEm',
    'criadoEm','criadoPor'];
  -- campos de data/hora que o app lê como Timestamp
  campos_ts constant text[] := array['ts','ultimo','createdAt','updatedAt',
    'finalizadoEm','criadoEm'];
  ignorar text[] := array['id','senha','password','senha_hash','password_hash'];
  out jsonb := '{}'::jsonb;
  k text; v jsonb; nome text; tipo text; s text;
begin
  if tabela in ('ordens', 'travas') then
    ignorar := ignorar || 'data'::text; -- a data já está no caminho rotas/<data>/...
  end if;
  for k, v in select * from jsonb_each(linha) loop
    continue when k = any(ignorar) or v = 'null'::jsonb;

    -- tech_id / techid / techId → techId
    select c into nome from unnest(camel) c
     where lower(c) = lower(replace(k, '_', '')) limit 1;
    nome := coalesce(nome, k);
    -- se existirem as duas colunas (tech_id e techId), vale a de nome exato
    continue when nome <> k and linha ? nome and linha->nome <> 'null'::jsonb;

    tipo := tipos->>k;
    if jsonb_typeof(v) = 'string'
       and (tipo like 'timestamp%'
            or (nome = any(campos_ts) and (v#>>'{}') ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}')) then
      begin
        s := to_char((v#>>'{}')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
        v := jsonb_build_object('$ts', s);
      exception when others then
        null; -- texto que não é data: mantém como está
      end;
    end if;
    out := out || jsonb_build_object(nome, v);
  end loop;
  return out;
end $$;

revoke all on function public.fs_importar_dados(jsonb, jsonb, text) from public, anon, authenticated;

do $$
declare
  t text;
  tipos jsonb;
  colecao_sql text;
  filtro text;
  n int;
  ignorados int;
  resumo text := '';
begin
  foreach t in array array['cargos','usuarios','tecnicos','auxiliares','tipos_os',
                           'auditoria','historico_pendentes','ordens','travas'] loop
    if to_regclass(format('public.%I', t)) is null then
      resumo := resumo || format(E'\n  %-20s tabela não existe (pulada)', t);
      continue;
    end if;

    select jsonb_object_agg(column_name, data_type) into tipos
      from information_schema.columns
     where table_schema = 'public' and table_name = t;

    if not tipos ? 'id' then
      resumo := resumo || format(E'\n  %-20s sem coluna id (pulada)', t);
      continue;
    end if;

    if t in ('ordens', 'travas') then
      if not tipos ? 'data' then
        resumo := resumo || format(E'\n  %-20s sem coluna data (pulada)', t);
        continue;
      end if;
      colecao_sql := format($f$'rotas/' || to_char(x.data::date, 'YYYY-MM-DD') || '/%s'$f$, t);
      filtro := 'where x.data is not null and x.id is not null';
    else
      colecao_sql := quote_literal(t);
      filtro := 'where x.id is not null';
    end if;

    execute format($f$
      insert into public.documentos (colecao, id, dados)
      select %s, x.id::text, public.fs_importar_dados(to_jsonb(x), $1, %L)
        from public.%I x
       %s
      on conflict (colecao, id) do nothing
    $f$, colecao_sql, t, t, filtro) using tipos;
    get diagnostics n = row_count;

    execute format('select count(*) from public.%I', t) into ignorados;
    ignorados := ignorados - n;
    resumo := resumo || format(E'\n  %-20s %s importados', t, n)
      || case when ignorados > 0
              then format(' (%s já existiam ou sem id/data)', ignorados) else '' end;
  end loop;

  -- Quem já entrou no app novo antes desta importação ganhou um perfil
  -- automático (cargo c1) com o id do Supabase Auth. Esse perfil teria
  -- prioridade sobre o antigo; removemos quando existe um perfil importado
  -- com o mesmo e-mail e o automático não tem nada além dos campos padrão.
  delete from public.documentos p
   where p.colecao = 'usuarios'
     and p.id in (select u.id::text from auth.users u)
     and not exists (
       select 1 from jsonb_object_keys(p.dados) k
        where k not in ('nome','email','cargoId','ativo','ultimo'))
     and exists (
       select 1 from public.documentos o
        where o.colecao = 'usuarios' and o.id <> p.id
          and lower(trim(o.dados->>'email')) = lower(trim(p.dados->>'email')));
  get diagnostics n = row_count;
  if n > 0 then
    resumo := resumo || format(E'\n  %s perfil(is) automático(s) trocado(s) pelo perfil antigo', n);
  end if;

  raise notice E'Importação concluída:%', resumo;
end $$;

-- Resumo do que ficou na tabela documentos
select case when colecao like 'rotas/%/ordens' then 'rotas/*/ordens'
            when colecao like 'rotas/%/travas' then 'rotas/*/travas'
            else colecao end as colecao,
       count(*) as documentos
  from public.documentos
 group by 1
 order by 1;
