const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

// ══════════════════════════════════════════════════════════════
// FIREBASE ADMIN — lê a credencial da variável de ambiente do Render
// Configure no Render → Environment:
//   FIREBASE_CREDENCIAL → cole TODO o conteúdo do JSON da service account
//   API_AGENTE_KEY      → uma senha que você inventa (o agente do RD usa)
// ══════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
let dbPronto = false;

try {
  if (process.env.FIREBASE_CREDENCIAL) {
    const cred = JSON.parse(process.env.FIREBASE_CREDENCIAL);
    admin.initializeApp({ credential: admin.credential.cert(cred) });
    dbPronto = true;
    console.log('✓ Firebase Admin conectado');
  } else {
    console.warn('⚠ FIREBASE_CREDENCIAL não configurada — /api/visitas indisponível');
  }
} catch (e) {
  console.error('✗ Erro ao conectar Firebase:', e.message);
}

const AGENTE_KEY = process.env.API_AGENTE_KEY || 'chave-de-teste';

// ── Normaliza telefone: só números ──────────────────────────────
const soNumeros = s => String(s || '').replace(/\D/g, '');

// Normaliza telefone para comparação: remove o 55 (código do Brasil) e
// o 9 extra de celular, pegando só os últimos 8 dígitos (o número base)
// Assim "5511948901713", "11948901713" e "948901713" batem entre si
function telBate(telFirestore, telBusca) {
  const a = soNumeros(telFirestore);
  const b = soNumeros(telBusca);
  if (!a || !b) return false;
  // Compara pelos últimos 8 dígitos (parte que nunca muda)
  const fim = n => n.slice(-8);
  return fim(a) === fim(b);
}

// ══════════════════════════════════════════════════════════════
// GET /api/visita — o agente do RD busca a visita do cliente
// Parâmetros (qualquer um): ?telefone= | ?os= | ?nome=
// Header obrigatório: x-api-key
// ══════════════════════════════════════════════════════════════
app.get('/api/visita', async (req, res) => {
  const chave = req.headers['x-api-key'] || req.query.key;
  if (chave !== AGENTE_KEY) {
    return res.status(401).json({ erro: 'Chave de acesso inválida.' });
  }
  if (!dbPronto) {
    return res.status(503).json({ erro: 'Banco de dados não configurado no servidor.' });
  }

  const { telefone, os, nome } = req.query;
  if (!telefone && !os && !nome) {
    return res.status(400).json({ erro: 'Informe telefone, os ou nome.' });
  }

  try {
    const db = admin.firestore();
    // Buscar nos últimos 30 dias + próximos 30 dias
    const hoje = new Date();
    const resultados = [];

    for (let offset = -7; offset <= 30; offset++) {
      const d = new Date(hoje);
      d.setDate(hoje.getDate() + offset);
      const ds = d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

      const snap = await db.collection(`rotas/${ds}/ordens`).get();
      snap.forEach(doc => {
        const o = doc.data();
        const matchTel  = telefone && telBate(o.tel, telefone);
        const matchOS   = os && String(o.os) === String(os);
        const matchNome = nome && (o.nome_cliente || '').toLowerCase().includes(nome.toLowerCase());

        if (matchTel || matchOS || matchNome) {
          const STATUS = { finalizado: 'Finalizado', pendente: 'Aguardando atendimento', em_progresso: 'Em andamento' };
          const tec = o.techNome || '';
          resultados.push({
            os:        String(o.os || ''),
            cliente:   o.nome_cliente || '',
            data:      ds,
            data_br:   ds.split('-').reverse().join('/'),
            periodo:   o.periodo === 'tarde' ? 'tarde' : 'manhã',
            status:    STATUS[o.status] || o.status || '',
            tecnico:   tec,
            endereco:  [o.endereco, o.bairro].filter(Boolean).join(', '),
          });
        }
      });
    }

    if (resultados.length === 0) {
      return res.json({ encontrado: false, mensagem: 'Nenhuma visita encontrada para os dados informados.' });
    }

    // Ordena por data (mais próxima primeiro)
    resultados.sort((a, b) => a.data.localeCompare(b.data));
    res.json({ encontrado: true, total: resultados.length, visitas: resultados });

  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/export — BACKUP do Firestore (com opção de coleção única)
// Uso: /api/export?key=X            → tudo (pode estourar cota)
//      /api/export?key=X&col=ordens → só uma coleção (recomendado)
//      /api/export?key=X&col=ordens&mes=2026-08 → ordens de um mês
// ══════════════════════════════════════════════════════════════
app.get('/api/export', async (req, res) => {
  const chave = req.headers['x-api-key'] || req.query.key;
  if (chave !== AGENTE_KEY) {
    return res.status(401).json({ erro: 'Chave de acesso inválida.' });
  }
  if (!dbPronto) {
    return res.status(503).json({ erro: 'Banco de dados não configurado.' });
  }

  const db = admin.firestore();
  const col = req.query.col;   // coleção específica (opcional)
  const mes = req.query.mes;   // filtro de mês para ordens (opcional, ex: 2026-08)

  try {
    const backup = { exportadoEm: new Date().toISOString(), colecoes: {} };

    // Coleções simples da raiz
    const simples = ['tecnicos', 'auxiliares', 'tipos_os', 'cargos', 'usuarios', 'auditoria', 'historico_pendentes'];

    // Se pediu uma coleção simples específica
    if (col && simples.includes(col)) {
      const snap = await db.collection(col).get();
      backup.colecoes[col] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return enviar(res, backup, col);
    }

    // Se pediu ordens (a maior — busca por mês para não estourar)
    if (col === 'ordens' || col === 'travas') {
      backup.colecoes[col] = [];
      const rotasDocs = await db.collection('rotas').listDocuments();
      for (const rotaDoc of rotasDocs) {
        const data = rotaDoc.id;
        if (mes && !data.startsWith(mes)) continue; // filtra pelo mês pedido
        const sub = await rotaDoc.collection(col).get();
        sub.forEach(d => backup.colecoes[col].push({ id: d.id, data, ...d.data() }));
      }
      return enviar(res, backup, col + (mes ? '-' + mes : ''));
    }

    // Sem filtro: tenta tudo (pode estourar cota em bases grandes)
    for (const nome of simples) {
      const snap = await db.collection(nome).get();
      backup.colecoes[nome] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    backup.colecoes.ordens = [];
    backup.colecoes.travas = [];
    const rotasDocs = await db.collection('rotas').listDocuments();
    for (const rotaDoc of rotasDocs) {
      const data = rotaDoc.id;
      const ordSnap = await rotaDoc.collection('ordens').get();
      ordSnap.forEach(d => backup.colecoes.ordens.push({ id: d.id, data, ...d.data() }));
      const travSnap = await rotaDoc.collection('travas').get();
      travSnap.forEach(d => backup.colecoes.travas.push({ id: d.id, data, ...d.data() }));
    }
    return enviar(res, backup, 'completo');

  } catch (err) {
    res.status(500).json({ erro: err.message, dica: 'Se for quota, tente uma coleção por vez com ?col=' });
  }
});

function enviar(res, backup, sufixo) {
  const nome = `firestore-${sufixo}-${new Date().toISOString().split('T')[0]}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  res.send(JSON.stringify(backup, null, 2));
}

// ══════════════════════════════════════════════════════════════
// GET /api/sql — exporta os dados já em formato SQL (INSERT)
// Cola direto no SQL Editor do Supabase. Uma coleção por vez.
// Uso: /api/sql?key=X&col=tecnicos
//      /api/sql?key=X&col=ordens&mes=2026-08
// ══════════════════════════════════════════════════════════════
app.get('/api/sql', async (req, res) => {
  const chave = req.headers['x-api-key'] || req.query.key;
  if (chave !== AGENTE_KEY) return res.status(401).send('-- Chave inválida');
  if (!dbPronto) return res.status(503).send('-- Banco não configurado');

  const db = admin.firestore();
  const col = req.query.col;
  const mes = req.query.mes;

  // Escapa valores para SQL
  const esc = v => {
    if (v === null || v === undefined || v === '') return 'NULL';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'object') {
      // Timestamp do Firestore
      if (v._seconds !== undefined) return `to_timestamp(${v._seconds})`;
      if (v.seconds !== undefined) return `to_timestamp(${v.seconds})`;
      // Array/objeto → JSON
      return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
    }
    return `'${String(v).replace(/'/g, "''")}'`;
  };

  // Monta INSERT de uma linha
  const linha = (tabela, colunas, obj) => {
    const vals = colunas.map(c => esc(obj[c.src !== undefined ? c.src : c.col]));
    return `INSERT INTO ${tabela} (${colunas.map(c=>c.col).join(', ')}) VALUES (${vals.join(', ')}) ON CONFLICT (id) DO NOTHING;`;
  };

  try {
    let sql = `-- GestãoRotas — export SQL de "${col}${mes?' '+mes:''}"\n-- Gerado em ${new Date().toISOString()}\n\n`;

    if (col === 'tecnicos') {
      const snap = await db.collection('tecnicos').get();
      const cols = [{col:'id'},{col:'nome'},{col:'ini'},{col:'color'},{col:'tx'},{col:'placa'},{col:'placa_fim'},{col:'veiculo'},{col:'ordem'},{col:'ativo'}];
      snap.forEach(d=>{ sql += linha('tecnicos', cols, {id:d.id,...d.data()}) + '\n'; });
    }
    else if (col === 'auxiliares') {
      const snap = await db.collection('auxiliares').get();
      const cols = [{col:'id'},{col:'nome'},{col:'tec_id',src:'tecId'}];
      snap.forEach(d=>{ sql += linha('auxiliares', cols, {id:d.id,...d.data()}) + '\n'; });
    }
    else if (col === 'tipos_os') {
      const snap = await db.collection('tipos_os').get();
      const cols = [{col:'id'},{col:'label'},{col:'bg'},{col:'color'},{col:'ordem'}];
      snap.forEach(d=>{ sql += linha('tipos_os', cols, {id:d.id,...d.data()}) + '\n'; });
    }
    else if (col === 'cargos') {
      const snap = await db.collection('cargos').get();
      snap.forEach(d=>{
        const o={id:d.id,...d.data()};
        sql += `INSERT INTO cargos (id, nome, perms) VALUES (${esc(o.id)}, ${esc(o.nome)}, ${esc(o.perms||[])}) ON CONFLICT (id) DO NOTHING;\n`;
      });
    }
    else if (col === 'usuarios') {
      const snap = await db.collection('usuarios').get();
      const cols = [{col:'id'},{col:'nome'},{col:'email'},{col:'cargo_id',src:'cargoId'},{col:'ativo'}];
      snap.forEach(d=>{ sql += linha('usuarios', cols, {id:d.id,...d.data()}) + '\n'; });
    }
    else if (col === 'ordens') {
      const cols = [
        {col:'id'},{col:'os'},{col:'data'},{col:'tech_id',src:'techId'},{col:'status'},{col:'prio'},
        {col:'tipo'},{col:'periodo'},{col:'modelo'},{col:'serial'},{col:'defeito'},{col:'solucao'},
        {col:'nome_cliente',src:'nome_cliente'},{col:'tel'},{col:'endereco'},{col:'complemento'},
        {col:'bairro'},{col:'cep'},{col:'ftc'},{col:'faturado'},{col:'pecas'},{col:'pecas_lista',src:'pecas_lista'},
        {col:'valor'},{col:'obs'},{col:'obs_sel'},{col:'nota'},{col:'km'},{col:'posicao'}
      ];
      const rotasDocs = await db.collection('rotas').listDocuments();
      for (const rotaDoc of rotasDocs) {
        const data = rotaDoc.id;
        if (mes && !data.startsWith(mes)) continue;
        const sub = await rotaDoc.collection('ordens').get();
        sub.forEach(d=>{
          const o = {id:d.id, data, ...d.data()};
          // valor pode vir string vazia → tratar
          if(o.valor==='' || o.valor===undefined) o.valor = null; else o.valor = parseFloat(o.valor)||null;
          sql += linha('ordens', cols, o) + '\n';
        });
      }
    }
    else {
      return res.status(400).send('-- Coleção inválida. Use: cargos|usuarios|tipos_os|tecnicos|auxiliares|ordens');
    }

    // Baixar como arquivo .sql
    const nome = `${col}${mes?'-'+mes:''}.sql`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.send(sql);

  } catch (err) {
    res.status(500).send(`-- Erro: ${err.message}\n-- Se for quota, aguarde o reset ou tente uma coleção menor.`);
  }
});

// ── GET /api/status — health check leve (não bloqueia no Firestore) ──────
const _bootTime = Date.now();
app.get('/api/status', (req, res) => {
  const uptimeSeg = Math.floor((Date.now() - _bootTime) / 1000);
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    servico: 'GestãoRotas',
    versao: '2.2.1',
    uptime_segundos: uptimeSeg,
    uptime_legivel: uptimeSeg > 3600 ? Math.floor(uptimeSeg/3600)+'h' : Math.floor(uptimeSeg/60)+'min',
    memoria_mb: Math.round(mem.rss / 1024 / 1024),
    firebase: dbPronto,
    hora: new Date().toISOString(),
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) {
      res.status(500).send('index.html não encontrado no servidor.');
    }
  });
});

app.listen(PORT, () => {
  console.log(`✅ GestãoRotas v2 rodando na porta ${PORT}`);
});
