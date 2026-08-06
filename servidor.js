const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ── Endpoint de status para teste via cURL ──────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    servico: 'GestãoRotas',
    versao: '2.0.0',
    hora: new Date().toISOString(),
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ GestãoRotas v2 rodando na porta ${PORT}`);
});
