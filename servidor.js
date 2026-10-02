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
// Aceita também os nomes alternativos mais comuns (e ignora espaços colados por engano)
const env = (...nomes) => { for (const n of nomes) { const v = (process.env[n] || '').trim(); if (v) return v; } return ''; };
const SUPABASE_URL  = env('SUPABASE_URL', 'SUPABASE_PROJECT_URL', 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/+$/, '');
const SUPABASE_ANON = env('SUPABASE_ANON_KEY', 'SUPABASE_ANON', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
const SUPABASE_KEY  = env('SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY');
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
  return data.user;
}

// Ações que alteram algo fora do banco (rotas na Cobli): além do login, o cargo do usuário
// não pode ser "somente visualização". Mesmo critério do app e do banco (fs_somente_leitura):
// perfil = documento de "usuarios" com o id do login ou o mesmo e-mail; cargo c4 é o Visualizador padrão.
async function exigirEdicao(req, res) {
  const user = await exigirLogin(req, res);
  if (!user) return false;
  try {
    const email = (user.email || '').trim().toLowerCase();
    const { data: perfis, error } = await sb.from('documentos').select('id,dados').eq('colecao', 'usuarios');
    if (error) throw error;
    const perfil = perfis.find(p => p.id === user.id) || perfis
      .filter(p => String(p.dados?.email || '').trim().toLowerCase() === email)
      .sort((a, b) => (a.dados?.ativo === false) - (b.dados?.ativo === false) || (a.id < b.id ? -1 : 1))[0];
    const cargoId = perfil?.dados?.cargoId;
    if (cargoId) {
      const { data: cargo, error: e2 } = await sb.from('documentos').select('dados').eq('colecao', 'cargos').eq('id', String(cargoId)).maybeSingle();
      if (e2) throw e2;
      if (cargo ? cargo.dados?.somenteLeitura === true : cargoId === 'c4') {
        res.status(403).json({ error: { message: 'Seu acesso é somente de visualização.' } });
        return false;
      }
    }
    return true;
  } catch (e) {
    console.error('exigirEdicao:', e.message);
    res.status(500).json({ error: { message: 'Não foi possível verificar a sua permissão.' } });
    return false;
  }
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
// Rotas na Cobli (botão "Enviar para a Cobli" do quadro de rotas)
// POST /api/cobli/rotas          { rotas: [RouteInput] } → POST /public/v1/routes
// POST /api/cobli/rotas/excluir  { ids: [uuid] }         → DELETE /public/v2/routes
// A resposta da Cobli (status e corpo) é devolvida como veio.
// ══════════════════════════════════════════════════════════════
async function cobliEscrever(res, metodo, caminho, corpo) {
  try {
    const r = await fetch(COBLI_API_URL + caminho, {
      method: metodo,
      headers: { [COBLI_HEADER]: COBLI_API_KEY, Accept: 'application/json', ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    const texto = await r.text();
    if (!r.ok) console.error('Cobli rotas:', metodo, r.status, texto.slice(0, 300));
    res.status(r.status).type('application/json').send(texto || '{}');
  } catch (e) {
    res.status(502).json({ error: { message: 'Falha ao falar com a Cobli: ' + e.message } });
  }
}

app.post('/api/cobli/rotas', async (req, res) => {
  if (!COBLI_API_KEY) return res.status(503).json({ error: { message: 'Cobli não configurada: defina COBLI_API_KEY no Render.' } });
  if (!(await exigirEdicao(req, res))) return;
  const rotas = req.body?.rotas;
  if (!Array.isArray(rotas) || !rotas.length || rotas.length > 20 || rotas.some(r => !r || typeof r !== 'object' || !Array.isArray(r.services) || !r.services.length)) {
    return res.status(400).json({ error: { message: 'Envie de 1 a 20 rotas, cada uma com pelo menos uma parada.' } });
  }
  await cobliEscrever(res, 'POST', '/public/v1/routes', rotas);
});

app.post('/api/cobli/rotas/excluir', async (req, res) => {
  if (!COBLI_API_KEY) return res.status(503).json({ error: { message: 'Cobli não configurada: defina COBLI_API_KEY no Render.' } });
  if (!(await exigirEdicao(req, res))) return;
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id)))) {
    return res.status(400).json({ error: { message: 'Informe de 1 a 20 ids de rota.' } });
  }
  await cobliEscrever(res, 'DELETE', '/public/v2/routes?' + ids.map(id => 'ids=' + id).join('&') + '&propagation_type=ONLY_THIS_ROUTE');
});

// ══════════════════════════════════════════════════════════════
// GET /api/rd/indicadores?inicio=AAAA-MM-DD&fim=AAAA-MM-DD
// Indicadores de atendimento do RD Station Conversas (WhatsApp) para o dashboard.
// São da conta inteira do RD Conversas, não só das OS de campo.
// Render → Environment: RD_API_KEY (RD Conversas → Apps e Integrações → API)
// ══════════════════════════════════════════════════════════════
const RD_API_KEY = env('RD_API_KEY', 'RD_CONVERSAS_TOKEN');
const RD_API_URL = (process.env.RD_API_URL || 'https://api.tallos.com.br').replace(/\/+$/, '');
const _rdCache = new Map(); // "inicio|fim" → { em, dados } — a RD limita a 100 requisições a cada 2 min

app.get('/api/rd/indicadores', async (req, res) => {
  if (!RD_API_KEY) return res.status(503).json({ error: { message: 'RD Conversas não configurado: defina RD_API_KEY no Render.' } });
  if (!(await exigirLogin(req, res))) return;
  const inicio = String(req.query.inicio || ''), fim = String(req.query.fim || '');
  const reData = /^\d{4}-\d{2}-\d{2}$/;
  if (!reData.test(inicio) || !reData.test(fim) || inicio > fim) return res.status(400).json({ error: { message: 'Período inválido.' } });

  const chave = inicio + '|' + fim, guardado = _rdCache.get(chave);
  if (guardado && Date.now() - guardado.em < 5 * 60 * 1000) return res.json(guardado.dados);

  // A API recusa início = fim sem hora; com hora, um único dia funciona
  const periodo = `start_date=${inicio}T00:00:00&end_date=${fim}T23:59:59`;
  const rd = async caminho => {
    const r = await fetch(RD_API_URL + caminho, { headers: { Authorization: 'Bearer ' + RD_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(corpo?.error?.message || corpo?.message || `RD Conversas respondeu HTTP ${r.status}`); e.status = r.status; throw e; }
    return corpo;
  };
  try {
    // O resumo é obrigatório; retenção e novos contatos são complementos (se falharem, ficam de fora)
    const [resumo, retencao, origem] = await Promise.all([
      rd(`/v1/analytics/attendances/summary?${periodo}&timezone=America/Sao_Paulo`),
      rd(`/v1/analytics/attendances/retention?${periodo}&timezone=America/Sao_Paulo`).catch(() => null),
      rd(`/v1/analytics/contacts/origin?${periodo}`).catch(() => null),
    ]);
    const dados = {
      inicio, fim,
      atendimentos: resumo.attendancesTotal ?? 0,
      tma: resumo.tma || null,   // tempo médio de atendimento { val, unit: 'min' | 'h' }
      tme: resumo.tme || null,   // tempo médio de espera
      retencaoChatbot: retencao ? retencao.retention ?? null : null,           // % resolvido sem atendente
      atendimentosChatbot: retencao ? retencao.chatBotAttendances ?? null : null,
      novosContatos: origem && Array.isArray(origem.data) ? origem.data.reduce((s, d) => s + (d.total || 0), 0) : null,
    };
    _rdCache.set(chave, { em: Date.now(), dados });
    if (_rdCache.size > 200) _rdCache.delete(_rdCache.keys().next().value);
    res.json(dados);
  } catch (e) {
    console.error('RD Conversas:', e.status || '', e.message);
    res.status(e.status === 401 || e.status === 403 ? 502 : (e.status || 502)).json({ error: { message: 'RD Conversas: ' + e.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/rd/confirmar-visita  { telefone: '+55DDDNÚMERO', variaveis: [nome, os, data, período] }
// Envia ao cliente, pelo WhatsApp do RD Conversas, o template aprovado de confirmação de visita.
// O template é fixo (definido aqui no servidor): o navegador só escolhe o destinatário e as variáveis.
// A RD responde que aceitou o pedido; a entrega em si só aparece no painel do RD Conversas.
// Render → Environment: RD_TEMPLATE_VISITA (opcional; id do template, padrão "rotasapp_1790951503")
// ══════════════════════════════════════════════════════════════
const RD_TEMPLATE_VISITA = env('RD_TEMPLATE_VISITA') || '6abfc6030faed05466a0182d';

app.post('/api/rd/confirmar-visita', async (req, res) => {
  if (!RD_API_KEY) return res.status(503).json({ error: { message: 'RD Conversas não configurado: defina RD_API_KEY no Render.' } });
  if (!(await exigirEdicao(req, res))) return;
  const telefone = String(req.body?.telefone || ''), variaveis = req.body?.variaveis;
  if (!/^\+55\d{10,11}$/.test(telefone)) return res.status(400).json({ error: { message: 'Telefone inválido.' } });
  if (!Array.isArray(variaveis) || variaveis.length !== 4 || variaveis.some(v => typeof v !== 'string' || !v.trim() || v.length > 120)) {
    return res.status(400).json({ error: { message: 'Informe nome, OS, data e período.' } });
  }
  try {
    const r = await fetch(RD_API_URL + '/v3/messages/template/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RD_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ recipient_number: telefone, country_code: '55', template_message_id: RD_TEMPLATE_VISITA, variables: variaveis.map(v => v.trim()), sent_by: 'bot' }),
      signal: AbortSignal.timeout(30000),
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = corpo?.error?.message || corpo?.message || `RD Conversas respondeu HTTP ${r.status}`;
      console.error('RD confirmar-visita:', r.status, msg);
      return res.status(r.status === 401 || r.status === 403 ? 502 : r.status).json({ error: { message: 'RD Conversas: ' + msg } });
    }
    res.json({ enviado: true, id: corpo?.data?.id || null });
  } catch (e) {
    console.error('RD confirmar-visita:', e.message);
    res.status(502).json({ error: { message: 'Falha ao falar com o RD Conversas: ' + e.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// Resposta do cliente à confirmação de visita ("Confirmar" / "Preciso de reagendar")
// Fica em rotas/<data>/confirmacoes/<os>: { resposta: 'confirmado'|'reagendar', respostaEm, respostaVia }
// e aparece no card da OS. Chega por três caminhos:
//   1) o fluxo do RD Conversas chama /api/visita/resposta (mais confiável);
//   2) /api/rd/respostas consulta a última mensagem de cada cliente (plano Basic não dá o histórico:
//      só pega quem clicou no botão e não mandou mais nada depois);
//   3) marcação manual na janela de confirmações do app.
// ══════════════════════════════════════════════════════════════
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[*_~]/g, '').trim().toLowerCase();
function interpretarResposta(texto) {
  const t = semAcento(texto);
  if (/reagend|remarc/.test(t)) return 'reagendar';
  if (/^(confirm|sim\b|ok\b)/.test(t)) return 'confirmado';
  return null;
}
async function gravarResposta(linha, resposta, via, quandoIso) {
  const dados = { ...linha.dados, resposta, respostaVia: via, respostaEm: { $ts: quandoIso || new Date().toISOString() } };
  const { error } = await sb.from('documentos').update({ dados, atualizado_em: new Date().toISOString() })
    .eq('colecao', linha.colecao).eq('id', linha.id);
  if (error) throw error;
}
const diaSP = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); };

// GET ou POST /api/visita/resposta — chamado pelo fluxo do RD Conversas quando o cliente clica no botão
// Parâmetros: resposta (texto do botão: "Confirmar" / "Preciso de reagendar") e telefone ou os
// Header obrigatório: x-api-key (a mesma do /api/visita)
app.all('/api/visita/resposta', async (req, res) => {
  const chave = req.headers['x-api-key'] || req.query.key;
  if (chave !== AGENTE_KEY) return res.status(401).json({ erro: 'Chave de acesso inválida.' });
  if (!sb) return res.status(503).json({ erro: 'Banco de dados não configurado no servidor.' });
  const p = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const resposta = interpretarResposta(p.resposta);
  if (!resposta) return res.status(400).json({ erro: 'Informe resposta: "Confirmar" ou "Preciso de reagendar".' });
  if (!p.telefone && !p.os) return res.status(400).json({ erro: 'Informe telefone ou os.' });
  try {
    // Confirmações enviadas para visitas de hoje em diante (até 30 dias)
    const colecoes = []; for (let i = 0; i <= 30; i++) colecoes.push(`rotas/${diaSP(i)}/confirmacoes`);
    const linhas = await lerTudo(() => sb.from('documentos').select('colecao,id,dados').in('colecao', colecoes).order('colecao').order('id'));
    const achadas = linhas.filter(l => (p.os && String(l.dados?.os) === String(p.os)) || (p.telefone && telBate(l.dados?.telefone, p.telefone)));
    if (!achadas.length) return res.json({ ok: false, mensagem: 'Nenhuma confirmação de visita enviada para este cliente.' });
    // Vale para a visita mais próxima (todas as OS do cliente naquela data)
    const data = achadas[0].colecao.split('/')[1];
    const alvo = achadas.filter(l => l.colecao.split('/')[1] === data);
    for (const l of alvo) await gravarResposta(l, resposta, 'rd');
    res.json({ ok: true, resposta, data, data_br: data.split('-').reverse().join('/'), os: alvo.map(l => String(l.dados?.os || l.id)) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/rd/respostas { data: 'AAAA-MM-DD' } — consulta no RD Conversas a última mensagem de cada
// cliente que ainda não respondeu. No máximo uma varredura por data a cada 90 s (limite de uso da RD).
const _rdRespostasEm = new Map();
app.post('/api/rd/respostas', async (req, res) => {
  if (!RD_API_KEY) return res.status(503).json({ error: { message: 'RD Conversas não configurado: defina RD_API_KEY no Render.' } });
  if (!(await exigirLogin(req, res))) return;
  const data = String(req.body?.data || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: { message: 'Data inválida.' } });
  if (Date.now() - (_rdRespostasEm.get(data) || 0) < 90 * 1000) return res.json({ verificado: false, motivo: 'recente' });
  _rdRespostasEm.set(data, Date.now());
  if (_rdRespostasEm.size > 100) _rdRespostasEm.delete(_rdRespostasEm.keys().next().value);
  try {
    const linhas = await lerTudo(() => sb.from('documentos').select('colecao,id,dados').eq('colecao', `rotas/${data}/confirmacoes`).order('id'));
    const pendentes = linhas.filter(l => l.dados?.telefone && !l.dados?.resposta).slice(0, 60);
    let consultadas = 0; const novas = [];
    for (const l of pendentes) {
      const numero = String(l.dados.telefone).replace(/\D/g, '').replace(/^55/, '');
      const r = await fetch(`${RD_API_URL}/v2/contacts/${numero}/exists?channel=whatsapp&country_code=55`, {
        headers: { Authorization: 'Bearer ' + RD_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(20000),
      });
      if (r.status === 429) break; // limite da RD: continua na próxima varredura
      consultadas++;
      if (!r.ok) continue;
      const ultima = (await r.json().catch(() => ({})))?.data?.last_message_data;
      const enviadoEm = Date.parse(l.dados.enviadoEm?.$ts || '') || 0;
      const quando = Date.parse(ultima?.created_at || '') || 0;
      // Só vale clique em botão feito depois do envio da confirmação
      if (!ultima || ultima.type !== 'button_reply' || !quando || quando < enviadoEm) continue;
      const resposta = interpretarResposta(ultima.content);
      if (!resposta) continue;
      await gravarResposta(l, resposta, 'consulta', new Date(quando).toISOString());
      novas.push({ os: String(l.dados.os || l.id), resposta });
    }
    res.json({ verificado: true, pendentes: pendentes.length, consultadas, novas });
  } catch (e) {
    console.error('RD respostas:', e.message);
    res.status(502).json({ error: { message: 'Falha ao consultar o RD Conversas: ' + e.message } });
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
    // A OS guarda só o id do técnico (techId); o nome vem do cadastro de técnicos
    const tecnicos = await lerTudo(() => sb.from('documentos').select('id,dados').eq('colecao', 'tecnicos').order('id'));
    const nomeTecnico = Object.fromEntries(tecnicos.map(t => [t.id, t.dados?.nome || '']));

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
          tecnico:  o.techNome || nomeTecnico[o.techId] || '',
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
    // Diagnóstico de configuração (só diz se existe, nunca o valor)
    config: {
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_ANON_KEY: !!SUPABASE_ANON,
      SUPABASE_SERVICE_KEY: !!SUPABASE_KEY,
      GEMINI_API_KEY: !!GEMINI_API_KEY,
      COBLI_API_KEY: !!COBLI_API_KEY,
      RD_API_KEY: !!RD_API_KEY,
    },
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
