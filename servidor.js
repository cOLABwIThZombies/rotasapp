const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname));

// ══════════════════════════════════════════════════════════════
// SUPABASE — configure no Render (Environment):
//   SUPABASE_URL          → Project URL (https://xxxxx.supabase.co)
//   SUPABASE_SERVICE_KEY  → service_role key (secreta!)
//   API_AGENTE_KEY        → chave para o agente do RD ler /api/visita
// ══════════════════════════════════════════════════════════════
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const AGENTE_KEY   = process.env.API_AGENTE_KEY || 'chave-de-teste';

let sb = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  console.log('✓ Supabase conectado');
} else {
  console.warn('⚠ SUPABASE_URL/KEY não configurados');
}

// CORS para /api
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const guard = (req, res) => {
  if (!sb) { res.status(503).json({ erro: 'Supabase não configurado' }); return false; }
  return true;
};

// ══════════════════════════════════════════════════════════════
// LOGIN — valida email/senha contra a tabela usuarios
// (mantém o modelo atual; senha simples — melhorar depois com hash)
// ══════════════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  if (!guard(req, res)) return;
  const { email, senha } = req.body;
  try {
    const { data, error } = await sb.from('usuarios').select('*').eq('email', email).eq('ativo', true).limit(1);
    if (error) throw error;
    if (!data.length) return res.status(401).json({ erro: 'Usuário não encontrado' });
    const u = data[0];
    // Se você guarda senha na tabela, valida aqui. Por ora aceita qualquer (ajuste conforme seu esquema)
    res.json({ ok: true, usuario: { id: u.id, nome: u.nome, email: u.email, cargoId: u.cargo_id } });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// BOOT — carrega dados base de uma vez (técnicos, tipos, etc.)
// ══════════════════════════════════════════════════════════════
app.get('/api/boot', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const [tec, aux, tip, car, usu] = await Promise.all([
      sb.from('tecnicos').select('*').order('ordem'),
      sb.from('auxiliares').select('*'),
      sb.from('tipos_os').select('*').order('ordem'),
      sb.from('cargos').select('*'),
      sb.from('usuarios').select('*').eq('ativo', true),
    ]);
    res.json({
      tecnicos: tec.data || [],
      auxiliares: aux.data || [],
      tipos: tip.data || [],
      cargos: car.data || [],
      usuarios: usu.data || [],
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// ORDENS por data (o board de um dia)
// ══════════════════════════════════════════════════════════════
app.get('/api/ordens', async (req, res) => {
  if (!guard(req, res)) return;
  const { data, mes } = req.query;
  try {
    let q = sb.from('ordens').select('*');
    if (data) q = q.eq('data', data);
    else if (mes) q = q.gte('data', mes + '-01').lte('data', mes + '-31');
    q = q.order('posicao');
    const { data: rows, error } = await q;
    if (error) throw error;
    res.json(rows || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Criar OS
app.post('/api/ordens', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { error } = await sb.from('ordens').insert(req.body);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Atualizar OS
app.put('/api/ordens/:id', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { error } = await sb.from('ordens').update(req.body).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Deletar OS
app.delete('/api/ordens/:id', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { error } = await sb.from('ordens').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// CRUD genérico para tabelas de cadastro
// ══════════════════════════════════════════════════════════════
const TABELAS_OK = ['tecnicos', 'auxiliares', 'tipos_os', 'cargos', 'usuarios', 'travas', 'auditoria', 'historico_pendentes'];

app.post('/api/:tabela', async (req, res) => {
  if (!guard(req, res)) return;
  const t = req.params.tabela;
  if (!TABELAS_OK.includes(t)) return res.status(400).json({ erro: 'Tabela inválida' });
  try {
    const { error } = await sb.from(t).upsert(req.body);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/:tabela/:id', async (req, res) => {
  if (!guard(req, res)) return;
  const t = req.params.tabela;
  if (!TABELAS_OK.includes(t)) return res.status(400).json({ erro: 'Tabela inválida' });
  try {
    const { error } = await sb.from(t).update(req.body).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/:tabela', async (req, res) => {
  if (!guard(req, res)) return;
  const t = req.params.tabela;
  if (!TABELAS_OK.includes(t)) return res.status(400).json({ erro: 'Tabela inválida' });
  try {
    const { data, error } = await sb.from(t).select('*');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// /api/visita — para o agente do RD (mantido)
// ══════════════════════════════════════════════════════════════
app.get('/api/visita', async (req, res) => {
  const chave = req.headers['x-api-key'] || req.query.key;
  if (chave !== AGENTE_KEY) return res.status(401).json({ erro: 'Chave inválida' });
  if (!guard(req, res)) return;
  const { telefone, os, nome } = req.query;
  try {
    let q = sb.from('ordens').select('os, nome_cliente, data, periodo, status, tech_id, endereco, bairro, tel');
    if (os) q = q.eq('os', os);
    else if (nome) q = q.ilike('nome_cliente', `%${nome}%`);
    const { data: rows, error } = await q.limit(500);
    if (error) throw error;

    let resultado = rows || [];
    // Filtro de telefone (últimos 8 dígitos)
    if (telefone) {
      const fim = String(telefone).replace(/\D/g, '').slice(-8);
      resultado = resultado.filter(o => String(o.tel || '').replace(/\D/g, '').slice(-8) === fim);
    }
    if (!resultado.length) return res.json({ encontrado: false, mensagem: 'Nenhuma visita encontrada.' });

    const STATUS = { finalizado: 'Finalizado', pendente: 'Aguardando atendimento', em_progresso: 'Em andamento' };
    const visitas = resultado.map(o => ({
      os: o.os, cliente: o.nome_cliente,
      data: o.data, data_br: o.data ? o.data.split('-').reverse().join('/') : '',
      periodo: o.periodo === 'tarde' ? 'tarde' : 'manhã',
      status: STATUS[o.status] || o.status,
      endereco: [o.endereco, o.bairro].filter(Boolean).join(', '),
    }));
    res.json({ encontrado: true, total: visitas.length, visitas });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// /api/status — health check
// ══════════════════════════════════════════════════════════════
const _boot = Date.now();
app.get('/api/status', (req, res) => {
  res.json({
    ok: true, servico: 'GestãoRotas', versao: '3.0.0-supabase',
    supabase: !!sb,
    uptime_min: Math.floor((Date.now() - _boot) / 60000),
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
