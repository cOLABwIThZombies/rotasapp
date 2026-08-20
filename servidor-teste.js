const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get('/api/status', (req, res) => {
  res.json({ ok: true, versao: 'TESTE-MINIMO', hora: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) res.status(500).send('index.html nao encontrado');
  });
});

app.listen(PORT, () => {
  console.log(`Servidor TESTE rodando na porta ${PORT}`);
});
