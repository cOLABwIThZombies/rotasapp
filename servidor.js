const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

// ══════════════════════════════════════════════════════════════
// FIREBASE ADMIN — lê a credencial da variável de ambiente
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
    console.warn('⚠ FIREBASE_CREDENCIAL não configurada — /api/visita indisponível');
  }
} catch (e) {
  console.error('✗ Erro ao conectar Firebase:', e.message);
}

const AGENTE_KEY = process.env.API_AGENTE_KEY || 'chave-de-teste';
const soNumeros = s => String(s || '').replace(/\D/g, '');

// ══════════════════════════════════════════════════════════════
// GET /api/visita — o agente do RD busca a visita do cliente
// Parâmetros: ?telefone= | ?os= | ?nome=   Header: x-api-key
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
    const hoje = new Date();
    const resultados = [];

    for (let offset = -7; offset <= 30; offset++) {
      const d = new Date(hoje);
      d.setDate(hoje.getDate() + offset);
      const ds = d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

      const snap = await db.collection(`rotas/${ds}/ordens`).get();
      snap.forEach(doc => {
        const o = doc.data();
        const matchTel  = telefone && soNumeros(o.tel).includes(soNumeros(telefone));
        const matchOS   = os && String(o.os) === String(os);
        const matchNome = nome && (o.nome_cliente || '').toLowerCase().includes(nome.toLowerCase());

        if (matchTel || matchOS || matchNome) {
          const STATUS = { finalizado: 'Finalizado', pendente: 'Aguardando atendimento', em_progresso: 'Em andamento' };
          resultados.push({
            os:        String(o.os || ''),
            cliente:   o.nome_cliente || '',
            data:      ds,
            data_br:   ds.split('-').reverse().join('/'),
            periodo:   o.periodo === 'tarde' ? 'tarde' : 'manhã',
            status:    STATUS[o.status] || o.status || '',
            tecnico:   o.techNome || '',
            endereco:  [o.endereco, o.bairro].filter(Boolean).join(', '),
          });
        }
      });
    }

    if (resultados.length === 0) {
      return res.json({ encontrado: false, mensagem: 'Nenhuma visita encontrada.' });
    }
    resultados.sort((a, b) => a.data.localeCompare(b.data));
    res.json({ encontrado: true, total: resultados.length, visitas: resultados });

  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── GET /api/status — health check ─────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    servico: 'GestãoRotas',
    versao: '2.1.0',
    firebase: dbPronto,
    hora: new Date().toISOString(),
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ GestãoRotas v2 rodando na porta ${PORT}`);
});
