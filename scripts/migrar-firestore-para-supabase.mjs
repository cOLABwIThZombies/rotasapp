// ═══════════════════════════════════════════════════════════════════════════
// Migração ÚNICA: Firestore → Supabase (tabela public.documentos)
//
// Copia TODAS as coleções e subcoleções (tecnicos, usuarios, cargos, tipos_os,
// auxiliares, auditoria, historico_pendentes, rotas/<data>/ordens, rotas/<data>/travas...)
// com todos os campos. Pode rodar mais de uma vez: faz upsert (não duplica).
//
// Uso (dentro da pasta scripts/):
//   npm install
//   FIREBASE_CREDENCIAL="$(cat service-account.json)" \
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=... \
//   node migrar-firestore-para-supabase.mjs [--desde=2026-01-01] [--somente=usuarios,tecnicos] [--simular]
//
//   --desde=AAAA-MM-DD   copia só rotas a partir desta data, e de auditoria/historico_pendentes
//                        só os registros com "ts" a partir dela (economiza leituras do Firestore)
//   --somente=a,b        copia só estas coleções raiz
//   --espelhar           (com --desde) apaga do Supabase as OS/travas de rotas a partir da data
//                        que não existem mais no Firestore (apagadas ou movidas de dia)
//   --simular            só conta os documentos (e o que seria apagado), não grava nada
//
// Atualização incremental (ex.: trazer do Firestore o que mudou desde 20/09):
//   node migrar-firestore-para-supabase.mjs --desde=2026-09-20 --espelhar --simular
//   node migrar-firestore-para-supabase.mjs --desde=2026-09-20 --espelhar
// ═══════════════════════════════════════════════════════════════════════════
import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const DESDE = args.desde || null;
const SOMENTE = args.somente ? String(args.somente).split(',') : null;
const SIMULAR = !!args.simular;
const ESPELHAR = !!args.espelhar;
if (DESDE && !/^\d{4}-\d{2}-\d{2}$/.test(DESDE)) {
  console.error('--desde deve estar no formato AAAA-MM-DD.');
  process.exit(1);
}
if (ESPELHAR && !DESDE) {
  console.error('--espelhar só pode ser usado junto com --desde.');
  process.exit(1);
}

// ── Firebase ──
if (process.env.FIRESTORE_EMULATOR_HOST) {
  admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'demo-rotas' });
} else {
  if (!process.env.FIREBASE_CREDENCIAL) {
    console.error('Defina FIREBASE_CREDENCIAL com o JSON da service account do Firebase.');
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CREDENCIAL)) });
}
const fs = admin.firestore();

// ── Supabase ──
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const PRECISA_SUPABASE = !SIMULAR || ESPELHAR; // --espelhar --simular lê o Supabase para listar o que apagaria
if (PRECISA_SUPABASE && (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)) {
  console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_KEY.');
  process.exit(1);
}
const sb = PRECISA_SUPABASE ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }) : null;

// ── Conversão de valores (mesma codificação do supabase-firestore.js) ──
function isoMicro(ts) {
  const base = new Date(ts.seconds * 1000).toISOString().slice(0, 19);
  return `${base}.${String(ts.nanoseconds).padStart(9, '0').slice(0, 6)}Z`;
}
function converter(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $num: String(v) };
  if (typeof v !== 'object') return v;
  if (v instanceof admin.firestore.Timestamp) return { $ts: isoMicro(v) };
  if (v instanceof admin.firestore.DocumentReference) return v.path;
  if (v instanceof admin.firestore.GeoPoint) return { latitude: v.latitude, longitude: v.longitude };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (Array.isArray(v)) return v.map(converter);
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = converter(x);
  return o;
}

// ── Gravação em lotes ──
let fila = [], total = 0;
const porColecao = {};
const vistosRotas = new Set(); // "colecao/id" das rotas lidas no Firestore (para --espelhar)
async function gravar(colecao, id, dados) {
  porColecao[colecao.replace(/^rotas\/[^/]+\//, 'rotas/*/')] = (porColecao[colecao.replace(/^rotas\/[^/]+\//, 'rotas/*/')] || 0) + 1;
  total++;
  if (colecao.startsWith('rotas/')) vistosRotas.add(`${colecao}/${id}`);
  if (SIMULAR) return;
  fila.push({ colecao, id, dados: converter(dados) });
  if (fila.length >= 500) await descarregar();
}
async function descarregar() {
  if (!fila.length) return;
  const lote = fila; fila = [];
  const { error } = await sb.from('documentos').upsert(lote, { onConflict: 'colecao,id' });
  if (error) throw new Error(`Erro gravando no Supabase: ${error.message}`);
  process.stdout.write(`\r  ${total} documentos gravados...`);
}

// ── Percorre coleções recursivamente ──
async function copiarColecao(colRef) {
  const caminho = colRef.path;
  if (caminho === 'rotas' && DESDE) {
    // rotas/<data>: os documentos-pai normalmente não existem, só as subcoleções
    const refs = await colRef.listDocuments();
    for (const r of refs) {
      if (r.id < DESDE) continue;
      await copiarDocumento(r);
    }
    return;
  }
  if (DESDE && (caminho === 'auditoria' || caminho === 'historico_pendentes')) {
    // registros de log: só os gravados a partir da data (horário de Brasília)
    const inicio = admin.firestore.Timestamp.fromDate(new Date(`${DESDE}T00:00:00-03:00`));
    const snap = await colRef.where('ts', '>=', inicio).get();
    for (const s of snap.docs) await gravar(caminho, s.id, s.data());
    return;
  }
  const refs = await colRef.listDocuments(); // inclui documentos "fantasmas" com subcoleções
  const snaps = refs.length ? await fs.getAll(...refs) : [];
  for (const s of snaps) {
    if (s.exists) await gravar(caminho, s.id, s.data());
    // Só "rotas/<data>" (e documentos-fantasma) têm subcoleções neste app
    if (caminho === 'rotas' || !s.exists || process.env.MIGRAR_VARRER_TUDO) {
      for (const sub of await s.ref.listCollections()) await copiarColecao(sub);
    }
  }
}
async function copiarDocumento(ref) {
  const s = await ref.get();
  if (s.exists) await gravar(ref.parent.path, ref.id, s.data());
  for (const sub of await ref.listCollections()) await copiarColecao(sub);
}

const raiz = await fs.listCollections();
for (const c of raiz) {
  if (SOMENTE && !SOMENTE.includes(c.id)) continue;
  console.log(`→ ${c.id}`);
  await copiarColecao(c);
}
await descarregar();
console.log(`\n\n✓ ${SIMULAR ? 'Encontrados' : 'Migrados'} ${total} documentos:`);
for (const [c, n] of Object.entries(porColecao).sort()) console.log(`   ${c.padEnd(28)} ${n}`);

// ── --espelhar: remove do Supabase o que não existe mais no Firestore ──
if (ESPELHAR && (!SOMENTE || SOMENTE.includes('rotas'))) {
  const sobrando = []; // [{colecao, id}]
  for (let de = 0; ; de += 1000) {
    // 'rotas0' vem logo depois de 'rotas/...' na ordenação (collate "C")
    const { data, error } = await sb.from('documentos').select('colecao,id')
      .gte('colecao', `rotas/${DESDE}`).lt('colecao', 'rotas0')
      .order('colecao').order('id').range(de, de + 999);
    if (error) throw new Error(`Erro lendo o Supabase: ${error.message}`);
    for (const l of data) {
      if (/^rotas\/\d{4}-\d{2}-\d{2}\/[^/]+$/.test(l.colecao) && !vistosRotas.has(`${l.colecao}/${l.id}`)) {
        sobrando.push(l);
      }
    }
    if (data.length < 1000) break;
  }
  console.log(`\n${SIMULAR ? 'Seriam apagados' : 'Apagando'} ${sobrando.length} documentos de rotas que não existem mais no Firestore:`);
  for (const l of sobrando) console.log(`   ${l.colecao}/${l.id}`);
  if (!SIMULAR) {
    const porCol = {};
    for (const l of sobrando) (porCol[l.colecao] ||= []).push(l.id);
    for (const [colecao, ids] of Object.entries(porCol)) {
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await sb.from('documentos').delete()
          .eq('colecao', colecao).in('id', ids.slice(i, i + 200));
        if (error) throw new Error(`Erro apagando no Supabase: ${error.message}`);
      }
    }
    console.log('✓ Removidos.');
  }
}
process.exit(0);
