# Migração Firestore → Supabase

O app continua **igual**: o `index.html` usa a mesma API do Firebase, e o arquivo
`supabase-firestore.js` traduz tudo para o Supabase. Cada documento do Firestore vira
uma linha na tabela `documentos` (`colecao`, `id`, `dados` em JSON), com **todos** os campos.

## Passo a passo (faça num horário sem uso, ex.: à noite)

### 1. Criar a tabela no Supabase
Supabase → **SQL Editor** → cole todo o arquivo
`supabase/migrations/20260929000000_documentos.sql` → **Run**.
(Pode rodar mais de uma vez. Não mexe nas tabelas antigas `ordens`, `tecnicos`… da tentativa anterior.)

### 2. Configurar o Auth do Supabase
Authentication → **URL Configuration**:
- *Site URL*: o endereço do app no Render (ex.: `https://seuapp.onrender.com`)
- *Redirect URLs*: o mesmo endereço (usado no "esqueci minha senha")

### 3. Variáveis de ambiente no Render
| Variável | Onde pegar |
|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Project Settings → API → chave `anon` / publishable (pública) |
| `SUPABASE_SERVICE_KEY` | Project Settings → API → chave `service_role` (**secreta**) |
| `API_AGENTE_KEY` | a mesma de hoje (agente do RD) |
| `GEMINI_API_KEY` | Google AI Studio → Get API key (análise por IA) |
| `COBLI_API_KEY` | chave da API da Cobli (mapa da frota) |

Opcionais: `GEMINI_MODEL` (padrão `gemini-2.5-flash`); `COBLI_API_URL` / `COBLI_HEADER`
(padrão `https://api.cobli.co` e `cobli-api-key` — ajuste se o seu Worker antigo usava outros);
`MIGRAR_LOGIN_FIREBASE=0` desliga a migração automática de senhas (ver abaixo).

### 4. Copiar os dados do Firestore
Na sua máquina/Codespace, **logo antes** de publicar:
```bash
cd scripts
npm install
export FIREBASE_CREDENCIAL="$(cat service-account.json)"   # Firebase → Configurações → Contas de serviço → Gerar chave
export SUPABASE_URL=https://xxxx.supabase.co
export SUPABASE_SERVICE_KEY=...
node migrar-firestore-para-supabase.mjs --simular   # só conta os documentos
node migrar-firestore-para-supabase.mjs             # copia de verdade
```
Se a cota gratuita do Firestore (50 mil leituras/dia) for problema, use
`--desde=2026-01-01` para copiar só as rotas a partir de uma data.

> ⚠️ **Não rode a migração de novo depois que o app já estiver no Supabase**: ela
> sobrescreveria alterações novas com os dados antigos do Firestore.

### 5. Publicar
Faça o commit/push; o Render publica sozinho.

## Logins e senhas
Ninguém precisa trocar de senha. No primeiro login no app novo, se a conta ainda não
existe no Supabase, o servidor confere a senha no Firebase Auth e cria a conta no
Supabase com a **mesma senha**. O perfil (cargo, nome, histórico) é ligado pelo e-mail,
mantendo os IDs antigos.

Usuários novos: o app mostra as instruções (Supabase → Authentication → Users → Add user,
marcando "Auto Confirm User").

## Voltar para o Firestore (se precisar)
Reverta o commit. O Firestore continua intacto, mas **sem** o que foi lançado depois da troca.

## Testes
`tests/` compara o app com Firestore (emulador oficial) e com Supabase (local), lado a lado:
32 testes, incluindo navegador real com dois usuários simultâneos. Veja `tests/package.json`.
