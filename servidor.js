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

// ── GET /api/status — health check completo (para monitoramento) ──────
const _bootTime = Date.now();
app.get('/api/status', async (req, res) => {
  const uptimeSeg = Math.floor((Date.now() - _bootTime) / 1000);
  const mem = process.memoryUsage();

  // Testa conexão real com o Firestore (não só se inicializou)
  let firebaseOk = false;
  if (dbPronto) {
    try {
      await admin.firestore().collection('tecnicos').limit(1).get();
      firebaseOk = true;
    } catch (e) {
      firebaseOk = false;
    }
  }

  const tudoOk = firebaseOk; // adicione outras checagens críticas aqui
  res.status(tudoOk ? 200 : 503).json({
    ok: tudoOk,
    servico: 'GestãoRotas',
    versao: '2.2.0',
    uptime_segundos: uptimeSeg,
    uptime_legivel: uptimeSeg > 3600 ? Math.floor(uptimeSeg/3600)+'h' : Math.floor(uptimeSeg/60)+'min',
    memoria_mb: Math.round(mem.rss / 1024 / 1024),
    firebase: firebaseOk,
    hora: new Date().toISOString(),
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ GestãoRotas v2 rodando na porta ${PORT}`);
});
