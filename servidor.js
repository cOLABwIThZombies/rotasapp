const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// ══════════════════════════════════════════════════════════════
// SUPABASE — configure no Render (Environment):
//   SUPABASE_URL          → Project URL (https://xxxxx.supabase.co)
//   SUPABASE_ANON_KEY     → chave "anon"/"publishable" (pública, vai para o navegador)
//   SUPABASE_SERVICE_KEY  → chave "service_role" (SECRETA, só no servidor)
//   API_AGENTE_KEY        → chave do agente do RD (/api/visita e /api/export)
// Migração de senhas do Firebase (opcional, ligado por padrão):
//   FIREBASE_API_KEY      → apiKey do projeto Firebase antigo
//   MIGRAR_LOGIN_FIREBASE → "0" desliga
// ══════════════════════════════════════════════════════════════
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const AGENTE_KEY    = process.env.API_AGENTE_KEY || 'chave-de-teste';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDWskjClVZ5rRtWRUq-0SGTbRoXwXJIK9E';
const FIREBASE_AUTH_URL = process.env.FIREBASE_AUTH_URL || 'https://identitytoolkit.googleapis.com';
const MIGRAR_LOGIN = process.env.MIGRAR_LOGIN_FIREBASE !== '0';

let sb = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  console.log('✓ Supabase conectado');
} else {
  console.warn('⚠ SUPABASE_URL/SUPABASE_SERVICE_KEY não configurados');
}
if (!SUPABASE_ANON) console.warn('⚠ SUPABASE_ANON_KEY não configurada — o app não conseguirá logar');

// ── Não expor arquivos internos pelo express.static ──
app.use(['/tests', '/node_modules', '/supabase', '/scripts', '/servidor.js', '/servidor-teste.js', '/package.json', '/package-lock.json'],
  (req, res) => res.sendStatus(404));

// ── Configuração pública do navegador (URL + chave anon) ──
app.get('/config.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-store');
  res.send(`window.SUPABASE_CONFIG = ${JSON.stringify({
    url: SUPABASE_URL || '',
    anonKey: SUPABASE_ANON || '',
    migrarLoginUrl: MIGRAR_LOGIN ? '/api/migrar-login' : null,
  })};`);
});

// ── supabase-js servido localmente (sem depender de CDN) ──
app.get('/vendor/supabase.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(require.resolve('@supabase/supabase-js/dist/umd/supabase.js'));
});

app.use(express.static(__dirname, { index: 'index.html' }));

// CORS para /api
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Lê todas as linhas de uma consulta (o PostgREST devolve no máximo 1000 por vez)
async function lerTudo(montar) {
  const out = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await montar().range(de, de + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// ══════════════════════════════════════════════════════════════
// POST /api/migrar-login — migração transparente das senhas
// Se o e-mail/senha são válidos no Firebase Auth, cria (ou atualiza) a conta
// no Supabase Auth com a MESMA senha. Assim ninguém precisa trocar de senha.
// ══════════════════════════════════════════════════════════════
app.post('/api/migrar-login', async (req, res) => {
  if (!MIGRAR_LOGIN || !sb) return res.json({ migrado: false });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const senha = String(req.body?.senha || '');
  if (!email || !senha) return res.status(400).json({ migrado: false });
  try {
    const r = await fetch(`${FIREBASE_AUTH_URL}/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: senha, returnSecureToken: false }),
    });
    if (!r.ok) return res.json({ migrado: false });

    const existente = await acharUsuarioAuth(email);
    if (existente && existente.last_sign_in_at) {
      // Já usa o Supabase: a senha de lá é a que vale (não volta para a senha antiga)
      return res.json({ migrado: false });
    }
    if (existente) {
      const { error } = await sb.auth.admin.updateUserById(existente.id, { password: senha, email_confirm: true });
      if (error) throw error;
    } else {
      const { error } = await sb.auth.admin.createUser({ email, password: senha, email_confirm: true });
      if (error) throw error;
    }
    console.log(`✓ Login migrado do Firebase: ${email}`);
    res.json({ migrado: true });
  } catch (e) {
    console.error('migrar-login:', e.message);
    res.json({ migrado: false });
  }
});

async function acharUsuarioAuth(email) {
  for (let page = 1; ; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const u = data.users.find(x => (x.email || '').toLowerCase() === email);
    if (u) return u;
    if (data.users.length < 1000) return null;
  }
}

// ══════════════════════════════════════════════════════════════
// Só usuários logados no app podem usar a IA e o mapa (protege as chaves)
// O navegador manda o token do Supabase em "Authorization: Bearer ..."
// ══════════════════════════════════════════════════════════════
async function exigirLogin(req, res) {
  if (!sb) { res.status(503).json({ error: { message: 'Supabase não configurado no servidor.' } }); return false; }
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ error: { message: 'Faça login para usar este recurso.' } }); return false; }
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) { res.status(401).json({ error: { message: 'Sessão expirada. Entre novamente.' } }); return false; }
  return true;
}

// ══════════════════════════════════════════════════════════════
// POST /api/ia — proxy do Gemini (a chave fica só no servidor)
// Corpo: { prompt, maxTokens, json }  → devolve a resposta do Gemini como veio
// Render → Environment: GEMINI_API_KEY (Google AI Studio → Get API key)
//                       GEMINI_MODEL (opcional, padrão gemini-2.5-flash)
// ══════════════════════════════════════════════════════════════
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_URL = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com';

app.post('/api/ia', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(503).json({ error: { message: 'IA não configurada: defina GEMINI_API_KEY no Render.' } });
  if (!(await exigirLogin(req, res))) return;
  const prompt = String(req.body?.prompt || '');
  if (!prompt.trim()) return res.status(400).json({ error: { message: 'Prompt vazio.' } });
  if (prompt.length > 30000) return res.status(400).json({ error: { message: 'Prompt muito grande.' } });
  const maxTokens = Math.min(Math.max(parseInt(req.body?.maxTokens, 10) || 300, 1), 8192);
  const json = !!req.body?.json;

  const generationConfig = { temperature: json ? 0.2 : 0.3, maxOutputTokens: maxTokens };
  if (json) generationConfig.responseMimeType = 'application/json';
  // Modelos 2.5 "pensam" antes de responder e esse pensamento consome o limite de
  // tokens — com 300 tokens a resposta vinha vazia. Desliga o pensamento no Flash.
  if (/2\.5-flash/.test(GEMINI_MODEL)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  try {
    const r = await fetch(`${GEMINI_API_URL}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
      signal: AbortSignal.timeout(60000),
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = corpo?.error?.message || `Gemini respondeu HTTP ${r.status}`;
      console.error('Gemini:', r.status, msg);
      return res.status(r.status).json({ error: { message: 'Gemini: ' + msg } });
    }
    res.json(corpo);
  } catch (e) {
    console.error('Gemini:', e.message);
    res.status(502).json({ error: { message: 'Falha ao falar com o Gemini: ' + e.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/cobli — proxy da API da Cobli (mapa da frota)
// Corpo: { endpoint: '/herbie-1.1/devices' }
// Render → Environment: COBLI_API_KEY
//   (opcionais) COBLI_API_URL (padrão https://api.cobli.co), COBLI_HEADER (padrão cobli-api-key)
// ══════════════════════════════════════════════════════════════
const COBLI_API_KEY = process.env.COBLI_API_KEY || '';
const COBLI_API_URL = process.env.COBLI_API_URL || 'https://api.cobli.co';
const COBLI_HEADER  = process.env.COBLI_HEADER || 'cobli-api-key';

app.post('/api/cobli', async (req, res) => {
  if (!COBLI_API_KEY) return res.status(503).json({ error: { message: 'Cobli não configurada: defina COBLI_API_KEY no Render.' } });
  if (!(await exigirLogin(req, res))) return;
  const endpoint = String(req.body?.endpoint || '');
  if (!/^\/herbie-[\w.]+\/[\w\-/?=&.]*$/.test(endpoint)) return res.status(400).json({ error: { message: 'Endpoint Cobli inválido.' } });
  try {
    const r = await fetch(COBLI_API_URL + endpoint, {
      headers: { [COBLI_HEADER]: COBLI_API_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    const texto = await r.text();
    if (!r.ok) console.error('Cobli:', r.status, texto.slice(0, 200));
    res.status(r.status).type('application/json').send(texto || '{}');
  } catch (e) {
    res.status(502).json({ error: { message: 'Falha ao falar com a Cobli: ' + e.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/visita — o agente do RD busca a visita do cliente
// Parâmetros (qualquer um): ?telefone= | ?os= | ?nome=
// Header obrigatório: x-api-key
// ══════════════════════════════════════════════════════════════
const soNumeros = s => String(s || '').replace(/\D/g, '');
// Compara pelos últimos 8 dígitos: "5511948901713", "11948901713" e "948901713" batem
function telBate(telSalvo, telBusca) {
  const a = soNumeros(telSalvo), b = soNumeros(telBusca);
  if (!a || !b) return false;
  return a.slice(-8) === b.slice(-8);
}

app.get('/api/visita', async (req, res) => {
  const chave = req.headers['x-api-key'] || req.query.key;
  if (chave !== AGENTE_KEY) return res.status(401).json({ erro: 'Chave de acesso inválida.' });
  if (!sb) return res.status(503).json({ erro: 'Banco de dados não configurado no servidor.' });

  const { telefone, os, nome } = req.query;
  if (!telefone && !os && !nome) return res.status(400).json({ erro: 'Informe telefone, os ou nome.' });

  try {
    // Últimos 7 dias + próximos 30 dias
    const hoje = new Date();
    const colecoes = [];
    for (let offset = -7; offset <= 30; offset++) {
      const d = new Date(hoje);
      d.setDate(hoje.getDate() + offset);
      colecoes.push(`rotas/${d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })}/ordens`);
    }
    const linhas = await lerTudo(() => sb.from('documentos').select('colecao,id,dados')
      .in('colecao', colecoes).order('colecao').order('id'));

    const STATUS = { finalizado: 'Finalizado', pendente: 'Aguardando atendimento', em_progresso: 'Em andamento' };
    const resultados = [];
    for (const l of linhas) {
      const o = l.dados || {};
      const ds = l.colecao.split('/')[1];
      const matchTel  = telefone && telBate(o.tel, telefone);
      const matchOS   = os && String(o.os) === String(os);
      const matchNome = nome && (o.nome_cliente || '').toLowerCase().includes(String(nome).toLowerCase());
      if (matchTel || matchOS || matchNome) {
        resultados.push({
          os:       String(o.os || ''),
          cliente:  o.nome_cliente || '',
          data:     ds,
          data_br:  ds.split('-').reverse().join('/'),
          periodo:  o.periodo === 'tarde' ? 'tarde' : 'manhã',
          status:   STATUS[o.status] || o.status || '',
          tecnico:  o.techNome || '',
          endereco: [o.endereco, o.bairro].filter(Boolean).join(', '),
        });
      }
    }
    if (!resultados.length) {
      return res.json({ encontrado: false, mensagem: 'Nenhuma visita encontrada para os dados informados.' });
    }
    resultados.sort((a, b) => a.data.localeCompare(b.data));
    res.json({ encontrado: true, total: resultados.length, visitas: resultados });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/export — BACKUP em JSON
// Uso: /api/export?key=X              → tudo
//      /api/export?key=X&col=tecnicos → uma coleção
//      /api/export?key=X&col=ordens&mes=2026-08 → ordens (ou travas) de um mês
// ══════════════════════════════════════════════════════════════
app.get('/api/export', async (req, res) => {
  const chave = req.headers['x-api-key'] || req.query.key;
  if (chave !== AGENTE_KEY) return res.status(401).json({ erro: 'Chave de acesso inválida.' });
  if (!sb) return res.status(503).json({ erro: 'Banco de dados não configurado.' });

  const { col, mes } = req.query;
  try {
    const linhas = await lerTudo(() => {
      let q = sb.from('documentos').select('colecao,id,dados');
      if (col === 'ordens' || col === 'travas') q = q.like('colecao', `rotas/${mes ? mes + '-' : ''}%/${col}`);
      else if (col) q = q.eq('colecao', col);
      return q.order('colecao').order('id');
    });
    const backup = { exportadoEm: new Date().toISOString(), colecoes: {} };
    for (const l of linhas) {
      const partes = l.colecao.split('/');
      const nomeCol = partes[partes.length - 1];
      const item = { id: l.id, ...l.dados };
      if (partes[0] === 'rotas') item.data = partes[1];
      (backup.colecoes[nomeCol] ||= []).push(item);
    }
    const sufixo = col ? col + (mes ? '-' + mes : '') : 'completo';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="gestaorotas-${sufixo}-${new Date().toISOString().split('T')[0]}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// /api/status — health check
// ══════════════════════════════════════════════════════════════
const _boot = Date.now();
app.get('/api/status', (req, res) => {
  const uptimeSeg = Math.floor((Date.now() - _boot) / 1000);
  res.json({
    ok: true, servico: 'GestãoRotas', versao: '3.0.0-supabase',
    supabase: !!sb,
    uptime_segundos: uptimeSeg,
    uptime_legivel: uptimeSeg > 3600 ? Math.floor(uptimeSeg / 3600) + 'h' : Math.floor(uptimeSeg / 60) + 'min',
    memoria_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    hora: new Date().toISOString(),
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) res.status(500).send('index.html não encontrado');
  });
});

app.listen(PORT, () => {
  console.log(`✅ GestãoRotas v3 (Supabase) na porta ${PORT}`);
});
