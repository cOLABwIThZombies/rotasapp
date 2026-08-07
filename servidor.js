const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve arquivos estáticos da raiz do projeto
app.use(express.static(__dirname));

// ── Endpoint de status para teste via cURL ──────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    servico: 'GestãoRotas',
    versao: '2.0.0',
    hora: new Date().toISOString(),
  });
});

// Qualquer outra rota devolve o index.html (da raiz)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ GestãoRotas v2 rodando na porta ${PORT}`);
});
