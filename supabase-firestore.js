/* ═══════════════════════════════════════════════════════════════════════════
   supabase-firestore.js — camada de compatibilidade Firestore/Firebase Auth → Supabase

   O index.html continua usando exatamente a mesma API do Firebase
   (collection, doc, getDocs, setDoc, updateDoc, onSnapshot, writeBatch,
   serverTimestamp, signInWithEmailAndPassword, onAuthStateChanged...).
   Este módulo implementa essa API em cima do Supabase:

   • Dados: tabela public.documentos (colecao, id, dados jsonb) — cada documento
     do Firestore é gravado inteiro, com todos os campos. Nada é convertido para
     colunas, então nenhum campo novo quebra o salvamento.
   • Gravações: funções SQL atômicas (fs_set, fs_update, fs_delete, fs_batch).
     updateDoc mescla campo a campo com a linha travada, como no Firestore.
   • serverTimestamp(): resolvido pelo relógio do banco.
   • onSnapshot: Supabase Realtime (postgres_changes) + disparo local imediato
     após gravações do próprio usuário.
   • Auth: Supabase Auth (e-mail/senha). O uid exposto ao app é o id do perfil
     em "usuarios" com o mesmo e-mail, preservando os uids antigos do Firebase.

   Veja supabase/migrations/20260929000000_documentos.sql.
═══════════════════════════════════════════════════════════════════════════ */

const TABELA = 'documentos';
const PAGINA = 1000; // = max_rows padrão do PostgREST no Supabase

// ═══════════════════════════════════════════════════════════════════════════
// Erros no formato do Firebase (e.code / e.message)
// ═══════════════════════════════════════════════════════════════════════════
export class FirestoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FirebaseError';
    this.code = code;
  }
}
const erroArg = msg => new FirestoreError('invalid-argument', msg);

function traduzirErro(error) {
  if (error instanceof FirestoreError) return error;
  const msg = error?.message || String(error);
  const code = error?.code;
  if (code === 'P0002') return new FirestoreError('not-found', msg);
  if (code === 'PGRST205' || code === 'PGRST202' || code === '42P01' || code === '42883') {
    return new FirestoreError('failed-precondition',
      'Banco não preparado: rode o arquivo supabase/migrations/20260929000000_documentos.sql no SQL Editor do Supabase.');
  }
  if (code === '42501' || /permission denied|row-level security/i.test(msg)) {
    return new FirestoreError('permission-denied', 'Missing or insufficient permissions.');
  }
  if (code === 'PGRST301' || code === 'PGRST303' || /JWT/i.test(msg)) {
    return new FirestoreError('unauthenticated', msg);
  }
  if (/fetch|network|Failed to|ECONNREFUSED|timeout/i.test(msg)) {
    return new FirestoreError('unavailable', msg);
  }
  return new FirestoreError('unknown', msg);
}

// ═══════════════════════════════════════════════════════════════════════════
// Timestamp e sentinelas
// ═══════════════════════════════════════════════════════════════════════════
export class Timestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
  static now() { return Timestamp.fromMillis(Date.now()); }
  static fromDate(date) { return Timestamp.fromMillis(date.getTime()); }
  static fromMillis(ms) {
    const seconds = Math.floor(ms / 1000);
    const nanoseconds = Math.floor((ms - seconds * 1000) * 1e6);
    return new Timestamp(seconds, nanoseconds);
  }
  toDate() { return new Date(this.toMillis()); }
  toMillis() { return this.seconds * 1000 + this.nanoseconds / 1e6; }
  isEqual(o) { return o instanceof Timestamp && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; }
  toString() { return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`; }
  toJSON() { return { seconds: this.seconds, nanoseconds: this.nanoseconds }; }
  valueOf() {
    // Mesmo formato do Firebase: permite comparar timestamps com < e >
    const s = this.seconds - -62135596800;
    return String(s).padStart(12, '0') + '.' + String(this.nanoseconds).padStart(9, '0');
  }
  _iso() {
    const base = new Date(this.seconds * 1000).toISOString().slice(0, 19);
    return `${base}.${String(this.nanoseconds).padStart(9, '0').slice(0, 6)}Z`;
  }
  static _deIso(iso) {
    // "2026-09-29T12:00:00.123456Z" (ou com offset) → precisão de microssegundos
    const m = /^(.*?T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso);
    if (!m) return Timestamp.fromMillis(Date.parse(iso));
    const seconds = Math.floor(Date.parse(m[1] + (m[3] || 'Z')) / 1000);
    const nanoseconds = Number(((m[2] || '') + '000000000').slice(0, 9));
    return new Timestamp(seconds, nanoseconds);
  }
}

class FieldValue {
  constructor(tipo) { this._tipo = tipo; }
  isEqual(o) { return o instanceof FieldValue && o._tipo === this._tipo; }
}
export const serverTimestamp = () => new FieldValue('serverTimestamp');
export const deleteField = () => new FieldValue('delete');

// ═══════════════════════════════════════════════════════════════════════════
// Codificação JS ⇄ JSONB (com as mesmas validações do Firestore)
// ═══════════════════════════════════════════════════════════════════════════
const ehObjetoSimples = v => {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

function codificar(v, ctx, campo, dentroDeArray) {
  const onde = () => campo ? ` (found in field ${campo} in document ${ctx.caminho})` : ` (in document ${ctx.caminho})`;
  if (v === undefined) {
    throw erroArg(`Function ${ctx.fn}() called with invalid data. Unsupported field value: undefined${onde()}`);
  }
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $num: String(v) };
  if (v instanceof FieldValue) {
    if (dentroDeArray) {
      throw erroArg(`Function ${ctx.fn}() called with invalid data. ${v._tipo}() is not currently supported inside arrays${onde()}`);
    }
    if (v._tipo === 'serverTimestamp') return { $serverTimestamp: true };
    // deleteField() só é aceito no primeiro nível de updateDoc (tratado em codificarUpdate)
    throw erroArg(`Function ${ctx.fn}() called with invalid data. deleteField() can only be used with update() and set() with {merge:true}${onde()}`);
  }
  if (v instanceof Timestamp) return { $ts: v._iso() };
  if (v instanceof Date) {
    if (isNaN(v.getTime())) throw erroArg(`Function ${ctx.fn}() called with invalid data. Invalid Date${onde()}`);
    return { $ts: Timestamp.fromDate(v)._iso() };
  }
  if (Array.isArray(v)) {
    if (dentroDeArray) {
      throw erroArg(`Function ${ctx.fn}() called with invalid data. Nested arrays are not supported${onde()}`);
    }
    const out = [];
    for (let i = 0; i < v.length; i++) out.push(codificar(v[i], ctx, campo, true));
    return out;
  }
  if (ehObjetoSimples(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = codificar(x, ctx, campo ? `${campo}.${k}` : k, false);
    }
    return out;
  }
  const tipo = typeof v === 'object' ? (v.constructor?.name || 'object') : typeof v;
  throw erroArg(`Function ${ctx.fn}() called with invalid data. Unsupported field value: a custom ${tipo} object${onde()}`);
}

function codificarDoc(dados, fn, caminho) {
  if (!ehObjetoSimples(dados)) {
    throw erroArg(`Function ${fn}() called with invalid data. Data must be an object, but it was: ${dados === null ? 'null' : typeof dados}`);
  }
  const ctx = { fn, caminho };
  const out = {};
  for (const [k, v] of Object.entries(dados)) out[k] = codificar(v, ctx, k, false);
  return out;
}

function decodificar(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decodificar);
  const chaves = Object.keys(v);
  if (chaves.length === 1) {
    if (chaves[0] === '$ts' && typeof v.$ts === 'string') return Timestamp._deIso(v.$ts);
    if (chaves[0] === '$num') return Number(v.$num);
  }
  const out = {};
  for (const k of chaves) out[k] = decodificar(v[k]);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Ordenação idêntica à do Firestore
// null < boolean < número < timestamp < string < array < map
// ═══════════════════════════════════════════════════════════════════════════
function rankTipo(v) {
  if (v === null) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 2;
  if (v instanceof Timestamp) return 3;
  if (typeof v === 'string') return 4;
  if (Array.isArray(v)) return 8;
  return 9;
}
function compararTexto(a, b) {
  // Firestore compara strings pelos bytes UTF-8
  if (a === b) return 0;
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i++) if (ea[i] !== eb[i]) return ea[i] - eb[i];
  return ea.length - eb.length;
}
function compararValores(a, b) {
  const ra = rankTipo(a), rb = rankTipo(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 0: return 0;
    case 1: return (a === b) ? 0 : (a ? 1 : -1);
    case 2:
      if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : -1; // NaN vem antes de todos os números
      if (Number.isNaN(b)) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    case 3: return a.seconds - b.seconds || a.nanoseconds - b.nanoseconds;
    case 4: return compararTexto(a, b);
    case 8: {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const c = compararValores(a[i], b[i]);
        if (c) return c;
      }
      return a.length - b.length;
    }
    default: {
      const ka = Object.keys(a).sort(compararTexto), kb = Object.keys(b).sort(compararTexto);
      for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
        const c = compararTexto(ka[i], kb[i]) || compararValores(a[ka[i]], b[kb[i]]);
        if (c) return c;
      }
      return ka.length - kb.length;
    }
  }
}
function lerCampo(obj, caminho) {
  let atual = obj;
  for (const p of caminho.split('.')) {
    if (atual === null || typeof atual !== 'object' || !(p in atual)) return undefined;
    atual = atual[p];
  }
  return atual;
}

// ═══════════════════════════════════════════════════════════════════════════
// App / Firestore
// ═══════════════════════════════════════════════════════════════════════════
export function initializeApp(config) {
  const criar = config.createClient || globalThis.supabase?.createClient;
  if (!criar) throw new Error('supabase-js não carregado (inclua /vendor/supabase.js antes)');
  if (!config.url || !config.anonKey) {
    const faltando = [!config.url && 'SUPABASE_URL', !config.anonKey && 'SUPABASE_ANON_KEY'].filter(Boolean).join(' e ');
    throw new Error(`Supabase não configurado: falta ${faltando} nas variáveis de ambiente do servidor (Render → Environment)`);
  }
  const client = criar(config.url, config.anonKey, {
    auth: {
      persistSession: config.persistSession !== false,
      autoRefreshToken: true,
      detectSessionInUrl: config.detectSessionInUrl !== false,
      storageKey: config.storageKey,
    },
  });
  return { name: '[DEFAULT]', options: config, _client: client };
}

export function getFirestore(app) {
  if (!app._firestore) {
    app._firestore = { type: 'firestore', app, _client: app._client, _ouvintes: new Map() };
  }
  return app._firestore;
}

// ── Referências ─────────────────────────────────────────────────────────────
function normalizarCaminho(partes, fn) {
  const segs = [];
  for (const p of partes) {
    if (typeof p !== 'string') throw erroArg(`Function ${fn}() cannot be called with an empty path.`);
    for (const s of p.split('/')) if (s !== '') segs.push(s);
  }
  if (!segs.length) throw erroArg(`Function ${fn}() cannot be called with an empty path.`);
  return segs;
}

export class CollectionReference {
  constructor(firestore, segs) {
    this.type = 'collection';
    this.firestore = firestore;
    this._segs = segs;
    this.path = segs.join('/');
    this.id = segs[segs.length - 1];
    this._filtros = [];
    this._ordens = [];
    this._limite = null;
    this._grupo = false;
  }
  get parent() {
    return this._segs.length > 1 ? new DocumentReference(this.firestore, this._segs.slice(0, -1)) : null;
  }
  withConverter() { return this; }
}

export class DocumentReference {
  constructor(firestore, segs) {
    this.type = 'document';
    this.firestore = firestore;
    this._segs = segs;
    this.path = segs.join('/');
    this.id = segs[segs.length - 1];
    this._colecao = segs.slice(0, -1).join('/');
  }
  get parent() { return new CollectionReference(this.firestore, this._segs.slice(0, -1)); }
  withConverter() { return this; }
}

class Query {
  constructor(base, filtros, ordens, limite) {
    this.type = 'query';
    this.firestore = base.firestore;
    this._base = base;
    this.path = base.path;
    this._grupo = base._grupo;
    this._filtros = filtros;
    this._ordens = ordens;
    this._limite = limite;
  }
}

const AUTO_ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function autoId() {
  let id = '';
  const bytes = new Uint8Array(40);
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < bytes.length && id.length < 20; i++) {
    if (bytes[i] < 248) id += AUTO_ID[bytes[i] % 62];
  }
  return id.length === 20 ? id : id + autoId().slice(0, 20 - id.length);
}

export function collection(parent, caminho, ...resto) {
  const base = parent.type === 'firestore' ? [] : parent._segs;
  const fs = parent.type === 'firestore' ? parent : parent.firestore;
  const segs = [...base, ...normalizarCaminho([caminho, ...resto], 'collection')];
  if (segs.length % 2 === 0) {
    throw erroArg(`Invalid collection reference. Collection references must have an odd number of segments, but ${segs.join('/')} has ${segs.length}.`);
  }
  return new CollectionReference(fs, segs);
}

export function doc(parent, caminho, ...resto) {
  const fs = parent.type === 'firestore' ? parent : parent.firestore;
  if (parent.type === 'collection' && arguments.length === 1) {
    return new DocumentReference(fs, [...parent._segs, autoId()]);
  }
  const base = parent.type === 'firestore' ? [] : parent._segs;
  const segs = [...base, ...normalizarCaminho([caminho, ...resto], 'doc')];
  if (segs.length % 2 !== 0) {
    throw erroArg(`Invalid document reference. Document references must have an even number of segments, but ${segs.join('/')} has ${segs.length}.`);
  }
  return new DocumentReference(fs, segs);
}

export function collectionGroup(firestore, id) {
  const c = new CollectionReference(firestore, [id]);
  c._grupo = true;
  c.type = 'query';
  return c;
}

// ── Query constraints ──────────────────────────────────────────────────────
export const orderBy = (campo, direcao = 'asc') => ({ _tipo: 'orderBy', campo, direcao });
export const where = (campo, op, valor) => ({ _tipo: 'where', campo, op, valor });
export const limit = n => ({ _tipo: 'limit', n });

export function query(ref, ...restricoes) {
  const base = ref.type === 'query' && ref._base ? ref._base : ref;
  const filtros = [...(ref._filtros || [])];
  const ordens = [...(ref._ordens || [])];
  let limite = ref._limite ?? null;
  for (const r of restricoes) {
    if (r._tipo === 'orderBy') ordens.push(r);
    else if (r._tipo === 'where') filtros.push(r);
    else if (r._tipo === 'limit') limite = r.n;
  }
  return new Query(base, filtros, ordens, limite);
}

// ═══════════════════════════════════════════════════════════════════════════
// Snapshots
// ═══════════════════════════════════════════════════════════════════════════
const METADATA = Object.freeze({ hasPendingWrites: false, fromCache: false, isEqual: () => true });

export class DocumentSnapshot {
  constructor(ref, bruto) {
    this.ref = ref;
    this.id = ref.id;
    this.metadata = METADATA;
    this._bruto = bruto; // dados JSONB como vieram do banco (ou null)
  }
  exists() { return this._bruto !== null && this._bruto !== undefined; }
  data() { return this.exists() ? decodificar(this._bruto) : undefined; }
  get(campo) { return this.exists() ? lerCampo(this.data(), campo) : undefined; }
}
export class QueryDocumentSnapshot extends DocumentSnapshot {}

export class QuerySnapshot {
  constructor(q, docs) {
    this.query = q;
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
    this.metadata = METADATA;
  }
  forEach(cb, thisArg) { this.docs.forEach(d => cb.call(thisArg, d)); }
  docChanges() { return this.docs.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })); }
}

// ═══════════════════════════════════════════════════════════════════════════
// Leituras
// ═══════════════════════════════════════════════════════════════════════════
async function lerLinhas(fs, ref) {
  const linhas = [];
  for (let de = 0; ; de += PAGINA) {
    let q = fs._client.from(TABELA).select('colecao,id,dados');
    if (ref._grupo) {
      q = q.or(`colecao.eq.${ref.id},colecao.like.*/${ref.id}`);
      q = q.order('colecao').order('id');
    } else {
      q = q.eq('colecao', ref.path).order('id');
    }
    const { data, error } = await q.range(de, de + PAGINA - 1);
    if (error) throw traduzirErro(error);
    linhas.push(...data);
    if (data.length < PAGINA) break;
  }
  if (ref._grupo) linhas.sort((a, b) => compararTexto(`${a.colecao}/${a.id}`, `${b.colecao}/${b.id}`));
  return linhas;
}

const OPS = {
  '==': (a, b) => compararValores(a, b) === 0,
  '!=': (a, b) => compararValores(a, b) !== 0,
  '<': (a, b) => rankTipo(a) === rankTipo(b) && compararValores(a, b) < 0,
  '<=': (a, b) => rankTipo(a) === rankTipo(b) && compararValores(a, b) <= 0,
  '>': (a, b) => rankTipo(a) === rankTipo(b) && compararValores(a, b) > 0,
  '>=': (a, b) => rankTipo(a) === rankTipo(b) && compararValores(a, b) >= 0,
  'in': (a, b) => b.some(x => compararValores(a, x) === 0),
  'not-in': (a, b) => !b.some(x => compararValores(a, x) === 0),
  'array-contains': (a, b) => Array.isArray(a) && a.some(x => compararValores(x, b) === 0),
  'array-contains-any': (a, b) => Array.isArray(a) && a.some(x => b.some(y => compararValores(x, y) === 0)),
};

export async function getDocs(ref) {
  const fs = ref.firestore;
  const base = ref._base || ref;
  const linhas = await lerLinhas(fs, base);
  let itens = linhas.map(l => {
    const segs = [...l.colecao.split('/'), l.id];
    return { ref: new DocumentReference(fs, segs), bruto: l.dados, dados: decodificar(l.dados) };
  });

  // where
  for (const f of ref._filtros || []) {
    const valorFiltro = decodificar(codificar(f.valor, { fn: 'where', caminho: base.path }, f.campo, false));
    const teste = OPS[f.op];
    if (!teste) throw erroArg(`Invalid query. Unsupported operator '${f.op}'.`);
    itens = itens.filter(it => {
      const v = f.campo === '__name__' ? it.ref.id : lerCampo(it.dados, f.campo);
      if (v === undefined) return false;
      if (f.op === '!=' || f.op === 'not-in') { if (v === null) return false; }
      return teste(v, valorFiltro);
    });
  }

  // orderBy: documentos sem o campo ficam de fora (comportamento do Firestore);
  // empate → id do documento, na direção do último orderBy
  const ordens = ref._ordens || [];
  if (ordens.length) {
    itens = itens.filter(it => ordens.every(o => o.campo === '__name__' || lerCampo(it.dados, o.campo) !== undefined));
    const dirFinal = ordens[ordens.length - 1].direcao === 'desc' ? -1 : 1;
    itens.sort((a, b) => {
      for (const o of ordens) {
        const va = o.campo === '__name__' ? a.ref.path : lerCampo(a.dados, o.campo);
        const vb = o.campo === '__name__' ? b.ref.path : lerCampo(b.dados, o.campo);
        const c = compararValores(va, vb);
        if (c) return o.direcao === 'desc' ? -c : c;
      }
      return dirFinal * compararTexto(a.ref.path, b.ref.path);
    });
  }
  if (ref._limite != null) itens = itens.slice(0, ref._limite);

  return new QuerySnapshot(ref, itens.map(it => new QueryDocumentSnapshot(it.ref, it.bruto)));
}

export async function getDoc(ref) {
  const { data, error } = await ref.firestore._client.from(TABELA)
    .select('dados').eq('colecao', ref._colecao).eq('id', ref.id).maybeSingle();
  if (error) throw traduzirErro(error);
  return new DocumentSnapshot(ref, data ? data.dados : null);
}

// ═══════════════════════════════════════════════════════════════════════════
// Gravações
// ═══════════════════════════════════════════════════════════════════════════
async function rpc(fs, nome, args) {
  const { error } = await fs._client.rpc(nome, args);
  if (error) throw traduzirErro(error);
}

// Após gravar, avisa os onSnapshot desta aba na hora (latência zero, como no Firestore)
function avisarLocal(fs, colecoes) {
  for (const c of colecoes) {
    const set = fs._ouvintes.get(c);
    if (set) set.forEach(fn => fn());
  }
}

function codificarUpdate(ref, dados, fn) {
  if (!ehObjetoSimples(dados)) {
    throw erroArg(`Function ${fn}() called with invalid data. Data must be an object.`);
  }
  const ctx = { fn, caminho: ref.path };
  const out = {};
  for (const [k, v] of Object.entries(dados)) {
    if (v instanceof FieldValue && v._tipo === 'delete') { out[k] = { $delete: true }; continue; }
    out[k] = codificar(v, ctx, k, false);
  }
  return out;
}

export async function setDoc(ref, dados, opcoes) {
  if (opcoes && (opcoes.merge || opcoes.mergeFields)) {
    // setDoc com merge = updateDoc que cria o documento se não existir
    throw erroArg('setDoc(..., {merge:true}) não é suportado por esta camada.');
  }
  const d = codificarDoc(dados, 'setDoc', ref.path);
  await rpc(ref.firestore, 'fs_set', { p_colecao: ref._colecao, p_id: ref.id, p_dados: d });
  avisarLocal(ref.firestore, [ref._colecao]);
}

export async function updateDoc(ref, dados, ...pares) {
  if (typeof dados === 'string') {
    // updateDoc(ref, 'campo', valor, 'campo2', valor2...)
    const obj = { [dados]: pares[0] };
    for (let i = 1; i < pares.length; i += 2) obj[pares[i]] = pares[i + 1];
    dados = obj;
  }
  const d = codificarUpdate(ref, dados, 'updateDoc');
  await rpc(ref.firestore, 'fs_update', { p_colecao: ref._colecao, p_id: ref.id, p_dados: d });
  avisarLocal(ref.firestore, [ref._colecao]);
}

export async function deleteDoc(ref) {
  await rpc(ref.firestore, 'fs_delete', { p_colecao: ref._colecao, p_id: ref.id });
  avisarLocal(ref.firestore, [ref._colecao]);
}

export async function addDoc(colRef, dados) {
  const ref = doc(colRef);
  const d = codificarDoc(dados, 'addDoc', ref.path);
  await rpc(colRef.firestore, 'fs_set', { p_colecao: ref._colecao, p_id: ref.id, p_dados: d });
  avisarLocal(colRef.firestore, [ref._colecao]);
  return ref;
}

export function writeBatch(fs) {
  const ops = [];
  let fechado = false;
  const checar = () => { if (fechado) throw new FirestoreError('failed-precondition', 'A write batch can no longer be used after commit() has been called.'); };
  const batch = {
    set(ref, dados, opcoes) {
      checar();
      if (opcoes && (opcoes.merge || opcoes.mergeFields)) throw erroArg('set com merge não é suportado.');
      ops.push({ op: 'set', colecao: ref._colecao, id: ref.id, dados: codificarDoc(dados, 'WriteBatch.set', ref.path) });
      return batch;
    },
    update(ref, dados) {
      checar();
      ops.push({ op: 'update', colecao: ref._colecao, id: ref.id, dados: codificarUpdate(ref, dados, 'WriteBatch.update') });
      return batch;
    },
    delete(ref) {
      checar();
      ops.push({ op: 'delete', colecao: ref._colecao, id: ref.id });
      return batch;
    },
    async commit() {
      checar();
      fechado = true;
      if (!ops.length) return;
      await rpc(fs, 'fs_batch', { p_ops: ops });
      avisarLocal(fs, [...new Set(ops.map(o => o.colecao))]);
    },
  };
  return batch;
}

// ═══════════════════════════════════════════════════════════════════════════
// onSnapshot — Supabase Realtime
// ═══════════════════════════════════════════════════════════════════════════
let _seqCanal = 0;

export function onSnapshot(ref, ...args) {
  if (args.length && args[0] && typeof args[0] === 'object' && !('next' in args[0]) && typeof args[1] !== 'undefined') {
    args.shift(); // opções (includeMetadataChanges) — ignoradas
  }
  let proximo, erro;
  if (args[0] && typeof args[0] === 'object') { proximo = args[0].next?.bind(args[0]); erro = args[0].error?.bind(args[0]); }
  else { [proximo, erro] = args; }

  const fs = ref.firestore;
  const ehDoc = ref.type === 'document';
  const colecao = ehDoc ? ref._colecao : (ref._base || ref).path;
  let ativo = true, timer = null, seq = 0, ultimo = null;

  const executar = async () => {
    const meu = ++seq;
    try {
      const snap = ehDoc ? await getDoc(ref) : await getDocs(ref);
      if (!ativo || meu !== seq) return;
      // Não dispara de novo se nada mudou (o Firestore só avisa quando há mudança)
      const assinatura = JSON.stringify(ehDoc ? snap._bruto : snap.docs.map(d => [d.ref.path, d._bruto]));
      if (assinatura === ultimo) return;
      ultimo = assinatura;
      proximo && proximo(snap);
    } catch (e) {
      if (ativo && erro) erro(traduzirErro(e));
      else if (ativo) console.error('onSnapshot:', e);
    }
  };
  const agendar = () => { if (!ativo) return; clearTimeout(timer); timer = setTimeout(executar, 25); };

  // Registro local (gravações desta aba)
  if (!fs._ouvintes.has(colecao)) fs._ouvintes.set(colecao, new Set());
  fs._ouvintes.get(colecao).add(agendar);

  executar();

  const confere = linha => linha && linha.colecao === colecao && (!ehDoc || linha.id === ref.id);
  const canal = fs._client
    .channel(`fs-${++_seqCanal}-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TABELA, filter: `colecao=eq.${colecao}` },
      p => { if (confere(p.new)) agendar(); })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: TABELA, filter: `colecao=eq.${colecao}` },
      p => { if (confere(p.new)) agendar(); })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: TABELA },
      p => { if (confere(p.old)) agendar(); })
    // O servidor só começa a entregar mudanças um pouco depois do SUBSCRIBED;
    // quando confirma ("Subscribed to PostgreSQL"), relê para fechar essa janela
    .on('system', {}, p => { if (p?.extension === 'postgres_changes') agendar(); })
    .subscribe(status => {
      // Ao (re)conectar, relê para não perder mudanças feitas enquanto desconectado
      if (status === 'SUBSCRIBED') agendar();
    });

  return () => {
    ativo = false;
    clearTimeout(timer);
    fs._ouvintes.get(colecao)?.delete(agendar);
    fs._client.removeChannel(canal);
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTH — mesma interface do Firebase Auth
// ═══════════════════════════════════════════════════════════════════════════
class AuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'FirebaseError';
    this.code = code;
  }
}

function traduzirErroAuth(error) {
  const c = error?.code || '';
  const m = error?.message || '';
  if (c === 'invalid_credentials' || /Invalid login credentials/i.test(m)) {
    return new AuthError('auth/invalid-credential', 'Firebase: Error (auth/invalid-credential).');
  }
  if (c === 'email_not_confirmed' || /Email not confirmed/i.test(m)) {
    return new AuthError('auth/email-not-confirmed', 'E-mail ainda não confirmado. Confirme o usuário no Supabase (Authentication → Users).');
  }
  if (c === 'user_banned') return new AuthError('auth/user-disabled', 'Usuário desativado.');
  if (/rate_limit/.test(c) || error?.status === 429) return new AuthError('auth/too-many-requests', 'Muitas tentativas.');
  if (c === 'validation_failed' && /email/i.test(m)) return new AuthError('auth/invalid-email', m);
  if (/fetch|network|Failed to/i.test(m)) return new AuthError('auth/network-request-failed', m);
  return new AuthError(c ? `auth/${c.replace(/_/g, '-')}` : 'auth/internal-error', m);
}

class Auth {
  constructor(app) {
    this.app = app;
    this._client = app._client;
    this.currentUser = null;
    this._ouvintes = new Set();
    this._iniciado = false;
    this._authUid = undefined;  // id do usuário no Supabase Auth atualmente refletido
    this._fila = Promise.resolve();
    this._client.auth.onAuthStateChange((evento, sessao) => {
      // Nunca chamar o Supabase dentro do callback (pode travar) — adia
      setTimeout(() => this._enfileirar(() => this._aplicar(evento, sessao)), 0);
    });
  }

  _enfileirar(fn) {
    this._fila = this._fila.then(fn).catch(e => console.error('auth:', e));
    return this._fila;
  }

  async _aplicar(evento, sessao) {
    if (evento === 'PASSWORD_RECOVERY') this._pedirNovaSenha();
    const authUser = sessao?.user || null;
    const novoUid = authUser ? authUser.id : null;
    if (this._iniciado && novoUid === this._authUid) return; // TOKEN_REFRESHED etc: sem mudança
    this._authUid = novoUid;
    this.currentUser = authUser ? await this._montarUsuario(authUser) : null;
    this._iniciado = true;
    for (const cb of [...this._ouvintes]) {
      try { cb(this.currentUser); } catch (e) { console.error(e); }
    }
  }

  // uid exposto ao app = id do perfil em "usuarios" (mantém os ids antigos do Firebase)
  async _montarUsuario(authUser) {
    const email = (authUser.email || '').toLowerCase();
    let uid = authUser.id;
    try {
      const { data: proprio } = await this._client.from(TABELA)
        .select('id').eq('colecao', 'usuarios').eq('id', authUser.id).maybeSingle();
      if (!proprio && email) {
        const { data } = await this._client.from(TABELA)
          .select('id,dados').eq('colecao', 'usuarios').ilike('dados->>email', email.replace(/[\\%_]/g, c => '\\' + c));
        const achados = (data || [])
          .filter(l => String(l.dados?.email || '').trim().toLowerCase() === email)
          .sort((a, b) => (a.dados?.ativo === false) - (b.dados?.ativo === false) || compararTexto(a.id, b.id));
        if (achados.length) uid = achados[0].id;
      }
    } catch (e) {
      console.warn('Não foi possível localizar o perfil do usuário:', e);
    }
    return {
      uid,
      email: authUser.email,
      displayName: authUser.user_metadata?.nome || authUser.user_metadata?.full_name || null,
      emailVerified: !!authUser.email_confirmed_at,
      providerId: 'firebase',
      authId: authUser.id,
      getIdToken: async () => (await this._client.auth.getSession()).data.session?.access_token,
    };
  }

  async _pedirNovaSenha() {
    if (typeof window === 'undefined' || typeof window.prompt !== 'function') return;
    for (;;) {
      const s = window.prompt('Digite a nova senha (mínimo 6 caracteres):');
      if (s === null) return;
      if (s.length < 6) { window.alert('A senha precisa ter pelo menos 6 caracteres.'); continue; }
      const { error } = await this._client.auth.updateUser({ password: s });
      if (error) { window.alert('Erro ao salvar a senha: ' + error.message); continue; }
      window.alert('Senha alterada com sucesso!');
      try { history.replaceState(null, '', location.pathname); } catch (_) {}
      return;
    }
  }
}

export function getAuth(app) {
  if (!app._auth) app._auth = new Auth(app);
  return app._auth;
}

export function onAuthStateChanged(auth, cb) {
  auth._ouvintes.add(cb);
  if (auth._iniciado) auth._enfileirar(() => cb(auth.currentUser));
  return () => auth._ouvintes.delete(cb);
}

// Login. Se a conta ainda não existe no Supabase, o servidor tenta validar a
// mesma senha no Firebase Auth e cria a conta (migração transparente das senhas).
export async function signInWithEmailAndPassword(auth, email, senha) {
  email = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('auth/invalid-email', 'Firebase: Error (auth/invalid-email).');
  let { data, error } = await auth._client.auth.signInWithPassword({ email, password: senha });
  if (error && (error.code === 'invalid_credentials' || /Invalid login credentials/i.test(error.message))) {
    const url = auth.app.options.migrarLoginUrl;
    if (url) {
      try {
        const r = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, senha }),
        });
        if (r.ok && (await r.json()).migrado) {
          ({ data, error } = await auth._client.auth.signInWithPassword({ email, password: senha }));
        }
      } catch (_) { /* segue com o erro original */ }
    }
  }
  if (error) throw traduzirErroAuth(error);
  // Garante que onAuthStateChanged já rodou antes de devolver (igual ao Firebase)
  await auth._enfileirar(() => auth._aplicar('SIGNED_IN', data.session));
  return { user: auth.currentUser, providerId: null, operationType: 'signIn' };
}

export async function signOut(auth) {
  const { error } = await auth._client.auth.signOut();
  if (error && !/session/i.test(error.message)) throw traduzirErroAuth(error);
  await auth._enfileirar(() => auth._aplicar('SIGNED_OUT', null));
}

export async function sendPasswordResetEmail(auth, email) {
  const redirectTo = typeof location !== 'undefined' ? location.origin + location.pathname : undefined;
  const { error } = await auth._client.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw traduzirErroAuth(error);
}
