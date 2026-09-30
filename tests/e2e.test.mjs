// ═══════════════════════════════════════════════════════════════════════════
// Teste E2E no navegador: o MESMO roteiro de uso roda
//   (A) no app original com Firestore  (index.html do git, apontado para o emulador)
//   (B) no app novo com Supabase        (index.html atual servido pelo servidor.js)
// Os dados iniciais vêm do Firestore e são levados ao Supabase pelo script de migração.
// No fim, o estado dos dois bancos e o que aparece na tela têm que ser idênticos.
// ═══════════════════════════════════════════════════════════════════════════
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import admin from 'firebase-admin';
import {
  FB_PROJETO, FS_HOST, FS_PORTA, AUTH_PORTA, SB, sbAdmin,
  limparFirestore, limparFirebaseAuth, limparSupabase, limparSupabaseAuth, garantirUsuarioFirebase, ate, esperar,
} from './lib/ambiente.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const requireRaiz = createRequire(path.join(RAIZ, 'package.json'));
const express = requireRaiz('express');

const PORTA_FB = 3101, PORTA_SB = 3102, PORTA_MOCK = 3199;

// ── Gemini e Cobli simulados (registram o que o servidor mandou) ───────────
const chamadasMock = [];
let mockServidor;
function subirMock() {
  const app = express();
  app.use(express.json());
  app.post('/v1beta/models/:modelo', (req, res) => {
    chamadasMock.push({ api: 'gemini', modelo: req.params.modelo, chave: req.headers['x-goog-api-key'], corpo: req.body });
    const prompt = req.body.contents[0].parts[0].text;
    if (prompt.includes('FORCAR_ERRO')) return res.status(400).json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } });
    const oss = [...prompt.matchAll(/OS #(\d+)/g)].map(m => m[1]);
    const texto = req.body.generationConfig.responseMimeType === 'application/json'
      ? JSON.stringify({ itens: oss.map(os => ({ os, tipo: os === '1002' ? 'warn' : 'ok', texto: 'Análise simulada ' + os })) })
      : 'Verificar fonte em campo.';
    res.json({ candidates: [{ content: { parts: [{ text: texto }] }, finishReason: 'STOP' }] });
  });
  app.get('/herbie-1.1/devices', (req, res) => {
    chamadasMock.push({ api: 'cobli', chave: req.headers['cobli-api-key'] });
    res.json({ results: [] });
  });
  return new Promise(r => { const s = app.listen(PORTA_MOCK, () => r(s)); });
}
const d0 = new Date();
const dia = n => { const d = new Date(d0); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const HOJE = dia(0), ONTEM = dia(-1);
const PERMS = ['rotas', 'dashboard', 'calendario', 'finalizado', 'auditoria', 'relatorios', 'tecnicos', 'auxiliares', 'veiculos', 'usuarios', 'tipos', 'mapa'];

process.env.FIRESTORE_EMULATOR_HOST = `${FS_HOST}:${FS_PORTA}`;
admin.initializeApp({ projectId: FB_PROJETO });
const fsAdmin = admin.firestore();

let servidorFb, servidorSb, browser, uidAdmin, uidOper;

// ── Massa de dados inicial (no Firestore) ──────────────────────────────────
async function semear() {
  uidAdmin = await garantirUsuarioFirebase('admin@rotas.dev', 'senha123');
  uidOper = await garantirUsuarioFirebase('oper@rotas.dev', 'senha456');
  const T = admin.firestore.Timestamp;
  const set = (p, id, d) => fsAdmin.collection(p).doc(id).set(d);
  await set('cargos', 'c1', { nome: 'Administrador', perms: PERMS });
  await set('cargos', 'c3', { nome: 'Operacional', perms: ['rotas', 'dashboard', 'finalizado', 'calendario'] });
  await set('usuarios', uidAdmin, { nome: 'Ana Admin', email: 'admin@rotas.dev', cargoId: 'c1', ativo: true, ultimo: T.fromMillis(1750000000000) });
  await set('usuarios', uidOper, { nome: 'Otto Oper', email: 'oper@rotas.dev', cargoId: 'c3', ativo: true, ultimo: null });
  await set('tecnicos', 'tA', { nome: 'Carlos Silva', ini: 'CS', color: '#dbeafe', tx: '#1e3a8a', placa: 'ABC1231', placa_fim: 1, veiculo: 'Fiorino', ordem: 1, ativo: true });
  await set('tecnicos', 'tB', { nome: 'Bruno Costa', ini: 'BC', color: '#dcfce7', tx: '#14532d', placa: 'DEF4564', placa_fim: 4, veiculo: 'Kangoo', ordem: 2, ativo: true });
  await set('tecnicos', 'tC', { nome: 'Diego Alves', ini: 'DA', color: '#fee2e2', tx: '#7f1d1d', placa: 'GHI7897', placa_fim: 7, veiculo: 'Strada', ordem: 3, ativo: true });
  await set('tecnicos', 'tX', { nome: 'Velho Inativo', ini: 'VI', ordem: 4, ativo: false, removidoEm: T.fromMillis(1740000000000) });
  await set('auxiliares', 'a1', { nome: 'João P.', tecId: 'tA' });
  await set('auxiliares', 'a2', { nome: 'Marcos R.', tecId: 'tB' });
  await set('tipos_os', 't1', { label: '1ª Visita LP', bg: '#fdf0eb', color: '#7a2e14', ordem: 1 });
  await set('tipos_os', 't2', { label: 'Orç. Aprovado', bg: '#e4f7f1', color: '#085041', ordem: 2 });
  await set('tipos_os', 't3', { label: 'Retorno', bg: '#eef', color: '#223', ordem: 3 });
  const os = (n, tech, pos, extra = {}) => ({
    os: String(n), tipo: '1ª Visita LP', modelo: 'TV ' + n, serial: 'SN' + n, defeito: 'Não liga', solucao: '', periodo: 'manha',
    bairro: 'Centro', cep: '01000-000', prio: 'lp', techId: tech, obs: '', tel: '(11) 98888-' + String(n).slice(-4),
    nome_cliente: 'Cliente ' + n, endereco: 'Rua A, ' + n, complemento: '', pecas_lista: [], tat: '', status: 'em_progresso',
    ftc: 'nao', valor: '', pecas: 'nao', obs_sel: '', nota: '', posicao: pos, createdAt: T.fromMillis(1758000000000 + n), createdBy: uidAdmin, ...extra,
  });
  await set(`rotas/${HOJE}/ordens`, 'o1', os(1001, 'tA', 0));
  await set(`rotas/${HOJE}/ordens`, 'o2', os(1002, 'tA', 1, { periodo: 'tarde', pecas_lista: [{ codigo: 'BN96', desc: 'Placa', qty: 1 }], pecas: 'sim' }));
  await set(`rotas/${HOJE}/ordens`, 'o3', os(1003, 'tB', 0, { status: 'finalizado', valor: '250', finalizadoEm: T.fromMillis(1758003600000) }));
  await set(`rotas/${HOJE}/ordens`, 'o4', os(1004, 'tC', 0, { status: 'pendente', nota: 'Cliente ausente' }));
  await set(`rotas/${ONTEM}/ordens`, 'o5', os(1005, 'tB', 0, { status: 'finalizado', valor: '100.5', finalizadoEm: T.fromMillis(1757900000000) }));
  await set(`rotas/${ONTEM}/ordens`, 'o6', os(1006, 'tX', 0, { status: 'pendente' }));
  await set(`rotas/${ONTEM}/travas`, 'tC', { motivo: 'Carro na oficina', user: 'Ana Admin', ts: T.fromMillis(1757900000000) });
  await set('auditoria', 'au1', { os: '1005', acao: 'finalizacao', desc: 'Status: Em progresso → Finalizado', cor: 'ok', data: ONTEM, user: 'Ana Admin', uid: uidAdmin, hora: '10:00', ts: T.fromMillis(1757900000000), mudancas: [{ campo: 'Status', de: 'Em progresso', para: 'Finalizado' }] });
  await set('historico_pendentes', 'h1', { os: '1006', motivo: 'retorno', techId: 'tX', tecNome: 'Velho Inativo', data: ONTEM, hora: '11:00', ts: T.fromMillis(1757900000000), user: 'Ana Admin', uid: uidAdmin });
}

// ── Estado normalizado dos bancos ──────────────────────────────────────────
function normValor(v, chave) {
  if (chave === 'hora') return '<HORA>';
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if (v instanceof admin.firestore.Timestamp) return chave === 'ultimo' ? '<TS>' : (Math.abs(v.toMillis() - Date.now()) < 600000 ? '<TS≈agora>' : v.toMillis());
  if (typeof v.$ts === 'string' && Object.keys(v).length === 1) {
    const ms = Date.parse(v.$ts);
    return chave === 'ultimo' ? '<TS>' : (Math.abs(ms - Date.now()) < 600000 ? '<TS≈agora>' : ms);
  }
  if (Array.isArray(v)) return v.map(x => normValor(x));
  const o = {};
  for (const k of Object.keys(v).sort()) o[k] = normValor(v[k], k);
  return o;
}
const idNorm = id => (/^[A-Za-z0-9]{20}$/.test(id) ? '<AUTO>' : id);
function organizar(linhas) {
  const porCol = {};
  for (const { colecao, id, dados } of linhas) (porCol[colecao] ||= []).push({ id: idNorm(id), ...normValor(dados) });
  for (const c of Object.keys(porCol)) porCol[c] = porCol[c].map(x => JSON.stringify(x)).sort();
  return Object.fromEntries(Object.entries(porCol).sort());
}
async function estadoFirestore() {
  const linhas = [];
  async function col(ref) {
    for (const d of await ref.listDocuments()) {
      const s = await d.get();
      if (s.exists) linhas.push({ colecao: ref.path, id: d.id, dados: s.data() });
      for (const sub of await d.listCollections()) await col(sub);
    }
  }
  for (const c of await fsAdmin.listCollections()) await col(c);
  return organizar(linhas);
}
async function estadoSupabase() {
  const { data, error } = await sbAdmin().from('documentos').select('colecao,id,dados').range(0, 9999);
  if (error) throw error;
  return organizar(data);
}

// ── Servidores ──────────────────────────────────────────────────────────────
async function subirFirebase() {
  // index.html ORIGINAL (Firestore), apontado para os emuladores
  // Cópia congelada do index.html da versão Firestore (antes da migração)
  let html = readFileSync(path.join(AQUI, 'referencia', 'index-firestore.html'), 'utf8');
  html = html.replace(/const firebaseConfig = \{[\s\S]*?\};/, `const firebaseConfig = { apiKey: "fake", projectId: "${FB_PROJETO}", authDomain: "localhost" };`);
  html = html.replace('const db   = getFirestore(app);', `const db   = getFirestore(app);
{ const { connectAuthEmulator } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  const { connectFirestoreEmulator } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  connectAuthEmulator(auth, "http://${FS_HOST}:${AUTH_PORTA}", { disableWarnings: true });
  connectFirestoreEmulator(db, "${FS_HOST}", ${FS_PORTA}); }`);
  assert.ok(html.includes('connectFirestoreEmulator(db'), 'falha ao preparar o index.html do Firestore');
  const dir = path.join(AQUI, '.tmp-fb');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), html);
  const app = express();
  app.use(express.static(dir));
  return new Promise(r => { const s = app.listen(PORTA_FB, () => r(s)); });
}
async function subirSupabase() {
  const p = spawn(process.execPath, ['servidor.js'], {
    cwd: RAIZ,
    env: {
      ...process.env, PORT: String(PORTA_SB), SUPABASE_URL: SB.url, SUPABASE_ANON_KEY: SB.anonKey, SUPABASE_SERVICE_KEY: SB.serviceKey,
      FIREBASE_API_KEY: 'fake', FIREBASE_AUTH_URL: `http://${FS_HOST}:${AUTH_PORTA}/identitytoolkit.googleapis.com`, API_AGENTE_KEY: 'k-teste',
      GEMINI_API_KEY: 'chave-gemini-teste', GEMINI_API_URL: `http://127.0.0.1:${PORTA_MOCK}`,
      COBLI_API_KEY: 'chave-cobli-teste', COBLI_API_URL: `http://127.0.0.1:${PORTA_MOCK}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.saida = '';
  p.stdout.on('data', d => { p.saida += d; });
  p.stderr.on('data', d => { p.saida += d; });
  await ate(async () => (await fetch(`http://127.0.0.1:${PORTA_SB}/api/status`).catch(() => null))?.ok, { msg: 'servidor.js' });
  return p;
}

// ── Roteiro de uso (idêntico nas duas versões) ─────────────────────────────
async function abrir(url, email, senha, erros) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => erros.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) erros.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(url);
  await page.waitForSelector('#l-email', { state: 'visible' });
  await page.fill('#l-email', email);
  await page.fill('#l-pw', senha);
  await page.click('#btn-login');
  await page.waitForSelector('#pg-app.on');
  await page.waitForFunction(() => !document.getElementById('app-loading').classList.contains('on'));
  await page.waitForFunction(() => document.querySelectorAll('.lane').length > 0);
  await page.waitForFunction(n => document.querySelectorAll('.osc').length >= n, 4);
  return { ctx, page };
}
const quadro = page => page.evaluate(() => [...document.querySelectorAll('.lane')].map(l => ({
  tec: l.querySelector('.tname').textContent.trim(),
  aux: l.querySelector('.taux').textContent.trim(),
  badge: l.querySelector('.sbadge').textContent.trim(),
  travada: l.classList.contains('locked'),
  cards: [...l.querySelectorAll('.osc')].map(c => c.innerText.replace(/\s+/g, ' ').trim()),
})));
const recarregarOrdens = page => page.evaluate(async () => { await fetchOrdens(currentDate); });
const cardDaOS = (page, os) => page.locator('.osc', { has: page.locator('.osc-num', { hasText: os }) });

async function roteiro(url) {
  const erros = [], obs = {};
  const { ctx, page } = await abrir(url, 'admin@rotas.dev', 'senha123', erros);
  obs.usuarioTopo = await page.locator('#sav-nm').textContent();
  obs.cargoTopo = await page.locator('#sav-rl').textContent();
  obs.quadroInicial = await quadro(page);

  // 1. Nova OS pelo formulário
  await page.locator('.lane').nth(1).locator('.add-card').click();
  await page.fill('#m-os', '7770001');
  await page.fill('#m-modelo', 'Geladeira X');
  await page.fill('#m-defeito', 'Não gela');
  await page.fill('#m-bairro', 'Moema');
  await page.fill('#m-tel', '(11) 97777-0001');
  await page.fill('#m-nome-cliente', 'Maria Teste');
  await page.fill('#m-endereco', 'Av. Ibirapuera, 100');
  await page.click('button:has-text("Salvar OS")');
  await page.waitForFunction(() => !document.getElementById('modal-os').classList.contains('on'));
  await recarregarOrdens(page);
  await cardDaOS(page, '7770001').waitFor();

  // 2. Abrir drawer, editar e FINALIZAR
  await cardDaOS(page, '7770001').click();
  await page.waitForSelector('#drw-num:has-text("7770001")');
  await page.fill('#de-modelo', 'Geladeira X200');
  await page.fill('#de-solucao', 'Troca do termostato');
  await page.click('.drw-tab:has-text("Pós-rota")');
  await page.click('#rb-done');
  await page.fill('#drw-valor', '320.50');
  await page.click('button:has-text("Salvar alterações")');
  await page.waitForFunction(() => document.getElementById('toast-msg').textContent.includes('OS salva'));
  await esperar(800);
  await recarregarOrdens(page);

  // 3. OS existente → PENDENTE com anotação
  await cardDaOS(page, '1001').click();
  await page.waitForSelector('#drw-num:has-text("1001")');
  await page.click('.drw-tab:has-text("Pós-rota")');
  await page.click('#rb-pend');
  await page.selectOption('#drw-obs-sel', 'Cliente ausente');
  await page.fill('#drw-nota', 'Voltar amanhã cedo');
  await page.click('button:has-text("Salvar alterações")');
  await page.waitForFunction(() => document.getElementById('toast-msg').textContent.includes('OS salva'));
  await esperar(800);
  await recarregarOrdens(page);

  // 4. Arrastar OS 1002 do Carlos para o Diego
  const idO2 = await cardDaOS(page, '1002').getAttribute('data-id');
  await page.evaluate(async id => { draggingId = id; await dropOnLane('tC'); }, idO2);
  await esperar(500);
  await recarregarOrdens(page);

  // 5. Travar a rota do Bruno
  await page.locator('.lane[data-tid="tB"] .btn-lock').click();
  await page.fill('#trava-motivo-txt', 'Aguardando peça');
  await page.click('button:has-text("Travar rota")');
  await page.waitForFunction(() => !document.getElementById('modal-trava').classList.contains('on'));
  await page.evaluate(async () => { await subscribeTravas(currentDate); });

  obs.quadroFinalAdmin = await quadro(page);

  // 6. Segundo usuário, ao mesmo tempo, vê as mudanças e faz as suas
  const b = await abrir(url, 'oper@rotas.dev', 'senha456', erros);
  obs.usuarioTopoB = await b.page.locator('#sav-nm').textContent();
  obs.menuB = await b.page.evaluate(() => [...document.querySelectorAll('.ni[data-perm]')].filter(e => !e.classList.contains('hidden')).map(e => e.dataset.perm));
  obs.quadroVistoPorB = await quadro(b.page);
  await cardDaOS(b.page, '1004').click();
  await b.page.waitForSelector('#drw-num:has-text("1004")');
  await b.page.click('.drw-tab:has-text("Pós-rota")');
  await b.page.click('#rb-done');
  await b.page.fill('#drw-valor', '90');
  await b.page.click('button:has-text("Salvar alterações")');
  await b.page.waitForFunction(() => document.getElementById('toast-msg').textContent.includes('OS salva'));
  await esperar(800);
  // A (admin) recebe a mudança no próximo ciclo de atualização
  await recarregarOrdens(page);
  await page.waitForFunction(() => ordensForDate(currentDate).find(o => o.os === '1004')?.status === 'finalizado');

  // 7. Tempo real (onSnapshot): B altera o cargo; A vê sem recarregar
  await b.page.evaluate(async () => {
    const { updateDoc, doc } = getFB();
    await updateDoc(doc(getDB(), 'cargos', 'c3'), { nome: 'Operacional II' });
  });
  await page.waitForFunction(() => S.cargos.find(c => c.id === 'c3')?.nome === 'Operacional II', null, { timeout: 10000 });
  obs.cargosVistosPorA = await page.evaluate(() => S.cargos.map(c => c.nome).sort());

  // 8. Outras telas carregam sem erro
  for (const tela of ['dashboard', 'finalizado', 'calendario', 'relatorios', 'auditoria', 'tecnicos', 'usuarios', 'tipos']) {
    await page.evaluate(t => go(t, document.querySelector(`.ni[data-perm="${t}"]`)), tela);
    await esperar(400);
  }
  await page.waitForFunction(() => document.querySelectorAll('#audit-wrap .audit-item').length >= 5, null, { timeout: 10000 });
  obs.auditoria = await page.evaluate(() => [...document.querySelectorAll('#audit-wrap .audit-item')].map(e => e.innerText.replace(/\d{2}:\d{2}/g, 'HH:MM').replace(/\s+/g, ' ').trim()));
  obs.usuariosTela = await page.evaluate(() => S.usuarios.map(u => u.nome + '/' + u.cargoId).sort());

  // 9. Logout / login de novo
  await page.evaluate(async () => { stopAllListeners(); await getFB().signOut(getFB().auth); });
  await page.waitForSelector('#l-email', { state: 'visible' });
  obs.aposLogout = await page.evaluate(() => document.getElementById('pg-app').classList.contains('on'));

  // 10. Senha errada
  await page.fill('#l-email', 'admin@rotas.dev');
  await page.fill('#l-pw', 'errada');
  await page.click('#btn-login');
  await page.waitForFunction(() => document.getElementById('login-err').style.display === 'block');
  obs.erroSenha = (await page.locator('#login-err').textContent()) ? 'mostrou erro' : 'sem erro';

  await ctx.close(); await b.ctx.close();
  return { obs, erros };
}

// ═══════════════════════════════════════════════════════════════════════════
before(async () => {
  await limparFirestore(); await limparFirebaseAuth(); await limparSupabase(); await limparSupabaseAuth();
  await semear();
  browser = await chromium.launch();
  mockServidor = await subirMock();
});
after(async () => {
  await browser?.close();
  servidorFb?.close();
  servidorSb?.kill();
  mockServidor?.close();
});

test('migração copia 100% dos documentos do Firestore para o Supabase', async () => {
  execFileSync(process.execPath, ['migrar-firestore-para-supabase.mjs'], {
    cwd: path.join(RAIZ, 'scripts'),
    env: { ...process.env, SUPABASE_URL: SB.url, SUPABASE_SERVICE_KEY: SB.serviceKey, FIREBASE_PROJECT_ID: FB_PROJETO },
    stdio: 'pipe',
  });
  assert.deepStrictEqual(await estadoSupabase(), await estadoFirestore());
});

let resFb, resSb;
test('roteiro no app ORIGINAL (Firestore)', async () => {
  servidorFb = await subirFirebase();
  resFb = await roteiro(`http://127.0.0.1:${PORTA_FB}/`);
});

test('roteiro no app NOVO (Supabase) — login migra a senha do Firebase', async () => {
  servidorSb = await subirSupabase();
  resSb = await roteiro(`http://127.0.0.1:${PORTA_SB}/`);
  assert.match(servidorSb.saida, /Login migrado do Firebase: admin@rotas\.dev/);
  assert.match(servidorSb.saida, /Login migrado do Firebase: oper@rotas\.dev/);
});

test('tela: tudo que o usuário vê é idêntico', () => {
  assert.ok(resFb && resSb, 'roteiros não rodaram');
  for (const k of Object.keys(resFb.obs)) assert.deepStrictEqual(resSb.obs[k], resFb.obs[k], `diferença em "${k}"`);
});

test('banco: estado final idêntico (todas as coleções e campos)', async () => {
  assert.deepStrictEqual(await estadoSupabase(), await estadoFirestore());
});

test('sem erros de JavaScript no app novo', () => {
  assert.deepStrictEqual(resSb.erros, resFb.erros.filter(e => resSb.erros.includes(e)));
  assert.deepStrictEqual(resSb.erros, []);
});

test('/api/visita (agente do RD) encontra a OS no Supabase', async () => {
  const r = await fetch(`http://127.0.0.1:${PORTA_SB}/api/visita?os=7770001`, { headers: { 'x-api-key': 'k-teste' } }).then(r => r.json());
  assert.equal(r.encontrado, true);
  assert.equal(r.visitas[0].cliente, 'Maria Teste');
  assert.equal(r.visitas[0].status, 'Finalizado');
  const t = await fetch(`http://127.0.0.1:${PORTA_SB}/api/visita?telefone=5511977770001`, { headers: { 'x-api-key': 'k-teste' } }).then(r => r.json());
  assert.equal(t.total, 1);
  const sem = await fetch(`http://127.0.0.1:${PORTA_SB}/api/visita?os=1`);
  assert.equal(sem.status, 401);
});

test('segurança: sem login o Supabase não entrega nem aceita dados', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const anon = createClient(SB.url, SB.anonKey, { auth: { persistSession: false } });
  const { data } = await anon.from('documentos').select('id').limit(5);
  assert.deepStrictEqual(data ?? [], []);
  const { error } = await anon.rpc('fs_set', { p_colecao: 'tecnicos', p_id: 'hack', p_dados: {} });
  assert.ok(error, 'anon conseguiu gravar!');
  for (const p of ['/servidor.js', '/package.json', '/tests/e2e.test.mjs', '/scripts/package.json']) {
    const r = await fetch(`http://127.0.0.1:${PORTA_SB}${p}`);
    assert.equal(r.status, 404, p);
  }
});

test('(diagnóstico) resumo do que foi comparado', async () => {
  if (!process.env.MOSTRAR) return;
  const est = await estadoSupabase();
  console.log('COLEÇÕES:', Object.fromEntries(Object.entries(est).map(([k, v]) => [k, v.length])));
  console.log('QUADRO FINAL:', JSON.stringify(resSb.obs.quadroFinalAdmin.map(l => [l.tec, l.travada, l.cards.map(c => c.slice(0, 40))]), null, 1));
  console.log('AUDITORIA:', resSb.obs.auditoria.slice(0, 4));
  console.log('ERROS FB:', resFb.erros, 'ERROS SB:', resSb.erros);
  const osNova = est['rotas/' + HOJE + '/ordens'].find(x => x.includes('7770001'));
  console.log('OS NOVA:', osNova);
});

test('IA (Gemini): botão "Analisar rota" do Romaneio funciona no app novo', async () => {
  const erros = [];
  const { ctx, page } = await abrir(`http://127.0.0.1:${PORTA_SB}/`, 'admin@rotas.dev', 'senha123', erros);
  await page.locator('.lane[data-tid="tC"] .btn-rom').click();
  await page.click('#conf-ok');            // "OS sem peças — continuar mesmo assim"
  await page.click('#btn-ia-rota');
  await page.waitForFunction(() => document.querySelectorAll('#rom-ia-panel .rom-ia-item').length > 0, null, { timeout: 15000 });
  const itens = await page.locator('#rom-ia-panel .rom-ia-item').allInnerTexts();
  await ctx.close();
  assert.deepStrictEqual(itens.map(t => t.trim()).sort(), ['#1002 — Análise simulada 1002', '#1004 — Análise simulada 1004']);
  const g = chamadasMock.filter(c => c.api === 'gemini').at(-1);
  assert.equal(g.modelo, 'gemini-2.5-flash:generateContent');
  assert.equal(g.chave, 'chave-gemini-teste');
  assert.equal(g.corpo.generationConfig.maxOutputTokens, 4000);
  assert.equal(g.corpo.generationConfig.responseMimeType, 'application/json');
  assert.deepStrictEqual(g.corpo.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.deepStrictEqual(erros, []);
});

test('IA (Gemini): sem login é recusado; erro do Gemini chega legível ao usuário', async () => {
  const semLogin = await fetch(`http://127.0.0.1:${PORTA_SB}/api/ia`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'oi' }) });
  assert.equal(semLogin.status, 401);
  const { createClient } = await import('@supabase/supabase-js');
  const c = createClient(SB.url, SB.anonKey, { auth: { persistSession: false } });
  const { data } = await c.auth.signInWithPassword({ email: 'admin@rotas.dev', password: 'senha123' });
  const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token };
  const ok = await fetch(`http://127.0.0.1:${PORTA_SB}/api/ia`, { method: 'POST', headers: h, body: JSON.stringify({ prompt: 'teste', maxTokens: 300 }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).candidates[0].content.parts[0].text, 'Verificar fonte em campo.');
  const err = await fetch(`http://127.0.0.1:${PORTA_SB}/api/ia`, { method: 'POST', headers: h, body: JSON.stringify({ prompt: 'FORCAR_ERRO' }) });
  assert.equal(err.status, 400);
  assert.match((await err.json()).error.message, /API key not valid/);
  const cob = await fetch(`http://127.0.0.1:${PORTA_SB}/api/cobli`, { method: 'POST', headers: h, body: JSON.stringify({ endpoint: '/herbie-1.1/devices' }) });
  assert.equal(cob.status, 200);
  assert.equal(chamadasMock.filter(x => x.api === 'cobli').at(-1).chave, 'chave-cobli-teste');
  const cobRuim = await fetch(`http://127.0.0.1:${PORTA_SB}/api/cobli`, { method: 'POST', headers: h, body: JSON.stringify({ endpoint: 'http://evil.com/x' }) });
  assert.equal(cobRuim.status, 400);
});
