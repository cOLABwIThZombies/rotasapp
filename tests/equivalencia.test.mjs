// ═══════════════════════════════════════════════════════════════════════════
// Teste de EQUIVALÊNCIA: cada cenário roda no Firestore (emulador oficial) e na
// camada Supabase. O resultado normalizado dos dois tem que ser idêntico.
// ═══════════════════════════════════════════════════════════════════════════
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  clienteFirebase, clienteSupabase, limparFirestore, limparSupabase, esperar, ate,
} from './lib/ambiente.mjs';

// Normaliza valores para comparação (Timestamps, ids automáticos, erros)
function norm(v, ctx = {}) {
  if (v === undefined) return '<undefined>';
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && Number.isNaN(v)) return '<NaN>';
    return v;
  }
  if (typeof v.toDate === 'function' && 'seconds' in v && 'nanoseconds' in v) {
    const ms = v.seconds * 1000 + v.nanoseconds / 1e6;
    if (ctx.agora && Math.abs(ms - ctx.agora) < 120000) return '<TS≈agora>';
    return `<TS ${v.seconds}.${String(v.nanoseconds).padStart(9, '0')}>`;
  }
  if (Array.isArray(v)) return v.map(x => norm(x, ctx));
  const o = {};
  for (const k of Object.keys(v).sort()) o[k] = norm(v[k], ctx);
  return o;
}
const idAuto = id => (/^[A-Za-z0-9]{20}$/.test(id) ? '<AUTO_ID>' : id);
const lista = snap => snap.docs.map(d => ({ id: d.id, dados: norm(d.data(), { agora: Date.now() }) }));
async function erroDe(fn) {
  try { await fn(); return 'sem erro'; }
  catch (e) { return { code: String(e.code).replace(/^firestore\//, '') }; }
}

let fb, sb, fb2, sb2;
before(async () => {
  await limparFirestore(); await limparSupabase();
  fb = await clienteFirebase(); fb2 = await clienteFirebase();
  sb = await clienteSupabase(); sb2 = await clienteSupabase({ email: 'outro@rotas.dev' });
});
after(async () => { for (const c of [fb, fb2, sb, sb2]) await c?.fechar(); });

// Executa o mesmo cenário nos dois bancos e compara
async function equivalente(nome, cenario) {
  const [a, b] = [[fb, fb2], [sb, sb2]];
  const rf = await cenario(a[0], a[1], nome);
  const rs = await cenario(b[0], b[1], nome);
  assert.deepStrictEqual(rs, rf, `Diferença no cenário "${nome}"`);
  return rf;
}
const T = (nome, cenario) => test(nome, () => equivalente(nome, cenario));

// ─────────────────────────────────────────────────────────────────────────────
T('setDoc/getDoc preserva todos os tipos de valor', async (F, _, n) => {
  const ref = F.doc(F.db, `t_${n.length}`, 'tipos');
  await F.setDoc(ref, {
    texto: 'Olá — ção ✓ 😀', vazio: '', int: 42, neg: -7, zero: 0, float: 3.14159, grande: 9007199254740991,
    nan: NaN, inf: Infinity, ninf: -Infinity, sim: true, nao: false, nulo: null,
    lista: [1, 'dois', { tres: 3, lista: [4] }, null, true], listaVazia: [], mapa: { a: { b: { c: 'fundo' } } }, mapaVazio: {},
    ts: F.Timestamp.fromMillis(1727600000123), data: new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)),
    'chave com espaço': 1, 'chave.com.ponto': 2,
  });
  const s = await F.getDoc(ref);
  return { existe: s.exists(), id: s.id, dados: norm(s.data()), json: JSON.stringify(norm(s.data())) };
});

T('Timestamp: campos seconds/nanoseconds, toDate, toMillis e JSON', async (F) => {
  const ref = F.doc(F.db, 'ts', 'x');
  await F.setDoc(ref, { t: F.Timestamp.fromMillis(1700000000456) });
  const t = (await F.getDoc(ref)).data().t;
  return { s: t.seconds, n: t.nanoseconds, iso: t.toDate().toISOString(), ms: t.toMillis(), json: JSON.stringify({ t }), maior: t > F.Timestamp.fromMillis(1600000000000) };
});

T('getDoc de documento inexistente', async (F) => {
  const s = await F.getDoc(F.doc(F.db, 'nada', 'nao-existe'));
  return { existe: s.exists(), dados: norm(s.data()), id: s.id };
});

T('setDoc substitui o documento inteiro', async (F) => {
  const ref = F.doc(F.db, 'sub', 'a');
  await F.setDoc(ref, { a: 1, b: 2, m: { x: 1, y: 2 } });
  await F.setDoc(ref, { c: 3, m: { z: 9 } });
  return norm((await F.getDoc(ref)).data());
});

T('updateDoc mescla campos, substitui mapas e aceita caminho com ponto', async (F) => {
  const ref = F.doc(F.db, 'upd', 'a');
  await F.setDoc(ref, { a: 1, b: 2, m: { x: 1, y: 2 }, n: { p: { q: 1, r: 2 } } });
  await F.updateDoc(ref, { b: 20, c: 30, m: { z: 3 } });
  await F.updateDoc(ref, { 'n.p.q': 100, 'novo.caminho.fundo': true });
  await F.updateDoc(ref, 'a', 'um', 'b', null);
  return norm((await F.getDoc(ref)).data());
});

T('updateDoc em documento inexistente falha com not-found e não cria nada', async (F) => {
  const ref = F.doc(F.db, 'upd2', 'nao-existe');
  const e = await erroDe(() => F.updateDoc(ref, { a: 1 }));
  return { e, existe: (await F.getDoc(ref)).exists() };
});

T('valores inválidos são rejeitados (undefined, array aninhado, função, classe)', async (F) => {
  const ref = F.doc(F.db, 'inv', 'a');
  class Coisa { constructor() { this.x = 1; } }
  const r = {
    undef: await erroDe(() => F.setDoc(ref, { a: undefined })),
    undefAninhado: await erroDe(() => F.setDoc(ref, { m: { a: undefined } })),
    undefEmArray: await erroDe(() => F.setDoc(ref, { l: [1, undefined] })),
    arrayAninhado: await erroDe(() => F.setDoc(ref, { l: [[1]] })),
    funcao: await erroDe(() => F.setDoc(ref, { f: () => 1 })),
    classe: await erroDe(() => F.setDoc(ref, { c: new Coisa() })),
    addUndef: await erroDe(() => F.addDoc(F.collection(F.db, 'inv'), { a: undefined })),
    updUndef: await erroDe(async () => { await F.setDoc(F.doc(F.db, 'inv', 'b'), { ok: 1 }); await F.updateDoc(F.doc(F.db, 'inv', 'b'), { a: undefined }); }),
    serverTsEmArray: await erroDe(() => F.setDoc(ref, { l: [F.serverTimestamp()] })),
    arrayComMapaComArray: await erroDe(() => F.setDoc(F.doc(F.db, 'inv', 'ok'), { l: [{ m: [1, 2] }] })),
  };
  const s = await F.getDocs(F.collection(F.db, 'inv'));
  return { r, ids: s.docs.map(d => d.id).sort() };
});

T('addDoc gera id automático de 20 caracteres e grava o documento', async (F) => {
  const col = F.collection(F.db, 'rotas/2026-09-29/ordens');
  const ref = await F.addDoc(col, { os: '123', posicao: 0 });
  const s = await F.getDoc(F.doc(F.db, 'rotas/2026-09-29/ordens', ref.id));
  return { id: idAuto(ref.id), path: ref.path.replace(ref.id, '<ID>'), dados: norm(s.data()), parentDoc: (await F.getDoc(F.doc(F.db, 'rotas', '2026-09-29'))).exists() };
});

T('getDocs sem orderBy ordena pelo id do documento', async (F) => {
  const ids = ['b', 'A', 'a', '10', '9', '_x', 'Z', 'á', 'aa', '0'];
  for (const id of ids) await F.setDoc(F.doc(F.db, 'ordid', id), { v: id });
  const s = await F.getDocs(F.collection(F.db, 'ordid'));
  return { ids: s.docs.map(d => d.id), size: s.size, empty: s.empty, existsProp: s.docs.every(d => !!d.exists), refs: s.docs.map(d => d.ref.path) };
});

T('orderBy: exclui docs sem o campo, desempata por id, tipos mistos, desc', async (F) => {
  const col = 'rotas/2026-01-01/ordens';
  const docs = {
    d1: { posicao: 2 }, d2: { posicao: 1 }, d3: { posicao: 1 }, d4: {}, d5: { posicao: '1' },
    d6: { posicao: null }, d7: { posicao: 1.5 }, d8: { posicao: -1 }, d9: { posicao: true }, d10: { posicao: 0 },
  };
  for (const [id, d] of Object.entries(docs)) await F.setDoc(F.doc(F.db, col, id), d);
  const asc = await F.getDocs(F.query(F.collection(F.db, col), F.orderBy('posicao', 'asc')));
  const desc = await F.getDocs(F.query(F.collection(F.db, col), F.orderBy('posicao', 'desc')));
  const padrao = await F.getDocs(F.query(F.collection(F.db, col), F.orderBy('posicao')));
  return { asc: asc.docs.map(d => d.id), desc: desc.docs.map(d => d.id), padrao: padrao.docs.map(d => d.id) };
});

T('orderBy por timestamp desc (auditoria)', async (F) => {
  const col = F.collection(F.db, 'auditoria');
  for (const [i, ms] of [1000, 5000, 3000, 3000].entries()) {
    await F.setDoc(F.doc(F.db, 'auditoria', 'a' + i), { ts: F.Timestamp.fromMillis(1700000000000 + ms), i });
  }
  await F.setDoc(F.doc(F.db, 'auditoria', 'semTs'), { i: 99 });
  const s = await F.getDocs(F.query(col, F.orderBy('ts', 'desc')));
  return s.docs.map(d => [d.id, d.data().i]);
});

T('serverTimestamp é resolvido pelo servidor (setDoc, updateDoc, addDoc, aninhado)', async (F) => {
  const ref = F.doc(F.db, 'srv', 'a');
  await F.setDoc(ref, { criado: F.serverTimestamp(), m: { t: F.serverTimestamp() } });
  await F.updateDoc(ref, { atualizado: F.serverTimestamp() });
  const r2 = await F.addDoc(F.collection(F.db, 'srv'), { ts: F.serverTimestamp() });
  const d = (await F.getDoc(ref)).data();
  const d2 = (await F.getDoc(r2)).data();
  return {
    dados: norm(d, { agora: Date.now() }), d2: norm(d2, { agora: Date.now() }),
    tipo: typeof d.criado.toDate, ordem: d.atualizado.toMillis() >= d.criado.toMillis(),
  };
});

T('deleteDoc: existente e inexistente (sem erro)', async (F) => {
  const ref = F.doc(F.db, 'del', 'a');
  await F.setDoc(ref, { a: 1 });
  await F.deleteDoc(ref);
  const e = await erroDe(() => F.deleteDoc(F.doc(F.db, 'del', 'nunca-existiu')));
  return { existe: (await F.getDoc(ref)).exists(), e };
});

T('getDocs de coleção vazia / subcoleção sem documento pai', async (F) => {
  const s = await F.getDocs(F.query(F.collection(F.db, 'rotas/2020-01-01/ordens'), F.orderBy('posicao', 'asc')));
  const t = await F.getDocs(F.collection(F.db, 'rotas/2020-01-01/travas'));
  return { size: s.size, empty: s.empty, docs: s.docs.length, t: t.size };
});

T('writeBatch aplica set/update/delete juntos', async (F) => {
  await F.setDoc(F.doc(F.db, 'aux', 'a'), { nome: 'A', tecId: 't1' });
  await F.setDoc(F.doc(F.db, 'aux', 'b'), { nome: 'B', tecId: 't2' });
  await F.setDoc(F.doc(F.db, 'aux', 'c'), { nome: 'C' });
  const b = F.writeBatch(F.db);
  b.update(F.doc(F.db, 'aux', 'a'), { tecId: 't2' });
  b.update(F.doc(F.db, 'aux', 'b'), { tecId: 't1' });
  b.delete(F.doc(F.db, 'aux', 'c'));
  b.set(F.doc(F.db, 'aux', 'd'), { nome: 'D', tecId: null });
  await b.commit();
  return lista(await F.getDocs(F.collection(F.db, 'aux')));
});

T('writeBatch é tudo-ou-nada (falha em um update desfaz o resto)', async (F) => {
  await F.setDoc(F.doc(F.db, 'aux2', 'a'), { v: 1 });
  const b = F.writeBatch(F.db);
  b.update(F.doc(F.db, 'aux2', 'a'), { v: 2 });
  b.set(F.doc(F.db, 'aux2', 'novo'), { v: 3 });
  b.update(F.doc(F.db, 'aux2', 'nao-existe'), { v: 4 });
  const e = await erroDe(() => b.commit());
  return { e, docs: lista(await F.getDocs(F.collection(F.db, 'aux2'))) };
});

T('writeBatch vazio e reuso após commit', async (F) => {
  const b = F.writeBatch(F.db);
  const e1 = await erroDe(() => b.commit());
  let e2;
  try { b.set(F.doc(F.db, 'x', 'y'), { a: 1 }); e2 = 'sem erro'; } catch (e) { e2 = { code: e.code }; }
  return { e1, e2 };
});

T('Timestamp lido e gravado de volta continua Timestamp (replicar pendentes)', async (F) => {
  const origem = F.doc(F.db, 'rotas/2026-02-01/ordens', 'o1');
  await F.setDoc(origem, { os: '1', finalizadoEm: F.Timestamp.fromMillis(1700000000789), createdAt: F.serverTimestamp(), pecas_lista: [{ codigo: 'X', qty: 2 }] });
  const d = (await F.getDoc(origem)).data();
  const { createdAt: _c, ...rest } = d;
  const novo = await F.addDoc(F.collection(F.db, 'rotas/2026-02-02/ordens'), { ...rest, status: 'pendente', createdAt: F.serverTimestamp() });
  const lido = (await F.getDoc(novo)).data();
  // Clone via JSON (modo demonstração) vira mapa comum
  await F.setDoc(F.doc(F.db, 'rotas/2026-02-02/ordens', 'json'), JSON.parse(JSON.stringify(rest)));
  const json = (await F.getDoc(F.doc(F.db, 'rotas/2026-02-02/ordens', 'json'))).data();
  return { lido: norm(lido, { agora: Date.now() }), json: norm(json), ehTs: typeof lido.finalizadoEm.toDate };
});

T('coleção com mais de 1000 documentos retorna tudo', async (F) => {
  const col = 'grande';
  for (let lote = 0; lote < 3; lote++) {
    const b = F.writeBatch(F.db);
    for (let i = 0; i < 450; i++) {
      const n = lote * 450 + i;
      b.set(F.doc(F.db, col, 'd' + String(n).padStart(5, '0')), { n, ts: F.Timestamp.fromMillis(1700000000000 + n * 1000) });
    }
    await b.commit();
  }
  const s = await F.getDocs(F.collection(F.db, col));
  const q = await F.getDocs(F.query(F.collection(F.db, col), F.orderBy('ts', 'desc')));
  return { size: s.size, primeiro: s.docs[0].id, ultimo: s.docs[s.size - 1].id, qPrimeiro: q.docs[0].data().n, qSize: q.size };
});

T('edições simultâneas de campos diferentes na mesma OS não se perdem', async (F, F2) => {
  const col = 'rotas/2026-03-03/ordens';
  await F.setDoc(F.doc(F.db, col, 'os1'), { os: '1', status: 'em_progresso' });
  const ops = [];
  for (let i = 0; i < 15; i++) {
    ops.push(F.updateDoc(F.doc(F.db, col, 'os1'), { ['a' + i]: i }));
    ops.push(F2.updateDoc(F2.doc(F2.db, col, 'os1'), { ['b' + i]: i }));
  }
  await Promise.all(ops);
  const d = (await F.getDoc(F.doc(F.db, col, 'os1'))).data();
  return { campos: Object.keys(d).sort(), status: d.status };
});

T('onSnapshot de coleção: inicial + mudanças de OUTRO usuário + exclusão + unsubscribe', async (F, F2) => {
  await F.setDoc(F.doc(F.db, 'cargos', 'c1'), { nome: 'Admin', perms: ['rotas', 'usuarios'] });
  const estados = [];
  let ultimo = null;
  const unsub = F.onSnapshot(F.collection(F.db, 'cargos'), snap => {
    ultimo = snap.docs.map(d => `${d.id}:${d.data().nome}:${(d.data().perms || []).join('+')}`).join('|');
  }, e => { ultimo = 'ERRO ' + e.code; });
  const passo = async (acao, esperado) => {
    await acao();
    await ate(() => ultimo === esperado, { msg: esperado, timeout: 10000 });
    estados.push(ultimo);
  };
  await passo(async () => {}, 'c1:Admin:rotas+usuarios');
  await passo(() => F2.setDoc(F2.doc(F2.db, 'cargos', 'c2'), { nome: 'Oper', perms: ['rotas'] }), 'c1:Admin:rotas+usuarios|c2:Oper:rotas');
  await passo(() => F2.updateDoc(F2.doc(F2.db, 'cargos', 'c1'), { perms: ['rotas'] }), 'c1:Admin:rotas|c2:Oper:rotas');
  await passo(() => F2.deleteDoc(F2.doc(F2.db, 'cargos', 'c2')), 'c1:Admin:rotas');
  await passo(() => F.updateDoc(F.doc(F.db, 'cargos', 'c1'), { nome: 'Adm' }), 'c1:Adm:rotas');
  // outra coleção não deve interferir
  await F2.setDoc(F2.doc(F2.db, 'outra', 'c9'), { nome: 'X' });
  unsub();
  await F2.setDoc(F2.doc(F2.db, 'cargos', 'c3'), { nome: 'Depois' });
  await esperar(1500);
  estados.push(ultimo);
  return estados;
});

T('onSnapshot de documento', async (F, F2) => {
  const ref = F.doc(F.db, 'usuarios', 'u1');
  const vistos = [];
  const unsub = F.onSnapshot(ref, s => vistos.push(s.exists() ? s.data().nome : '<não existe>'));
  await ate(() => vistos.length === 1, { msg: 'inicial' });
  await F2.setDoc(F2.doc(F2.db, 'usuarios', 'u1'), { nome: 'Ana' });
  await ate(() => vistos.at(-1) === 'Ana', { msg: 'Ana' });
  await F2.setDoc(F2.doc(F2.db, 'usuarios', 'u2'), { nome: 'Outro' }); // outro doc não dispara
  await F2.updateDoc(F2.doc(F2.db, 'usuarios', 'u1'), { nome: 'Ana Maria' });
  await ate(() => vistos.at(-1) === 'Ana Maria', { msg: 'Ana Maria' });
  await F2.deleteDoc(F2.doc(F2.db, 'usuarios', 'u1'));
  await ate(() => vistos.at(-1) === '<não existe>' && vistos.length > 1, { msg: 'excluído' });
  unsub();
  return vistos.filter((v, i) => v !== vistos[i - 1]);
});

T('referências: caminhos, id, parent e validação de segmentos', async (F) => {
  const c = F.collection(F.db, 'rotas/2026-09-29/ordens');
  const d = F.doc(F.db, 'rotas/2026-09-29/ordens', 'abc');
  const d2 = F.doc(F.db, 'rotas/2026-09-29/ordens/abc');
  const d3 = F.doc(c, 'xyz');
  const err = f => { try { f(); return 'sem erro'; } catch (e) { return e.code; } };
  return {
    c: [c.path, c.id, c.parent?.path], d: [d.path, d.id, d.parent.path], d2: d2.path, d3: d3.path,
    auto: idAuto(F.doc(c).id),
    colPar: err(() => F.collection(F.db, 'rotas/2026')), docImpar: err(() => F.doc(F.db, 'rotas')),
  };
});
