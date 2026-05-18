# GestãoRotas v2 — Sistema de Rotas Técnicas

Protótipo funcional completo. Abre direto no navegador sem dependências.

---

## Funcionalidades desta versão

- ✅ Login com autenticação simulada
- ✅ Quadro de rotas com drag and drop entre técnicos
- ✅ 14 tipos de OS no formulário de abertura
- ✅ Cards com número de OS em destaque + tipo colorido
- ✅ Drawer lateral ao clicar no card (status, FTC, valor, obs. pós-rota)
- ✅ Alerta de rodízio por placa no quadro
- ✅ Calendário operacional com feriados bloqueados
- ✅ Histórico finalizado (somente leitura, filtrável)
- ✅ Auditoria de alterações
- ✅ Relatórios com gráficos (Chart.js) — barras, pizza, donut
- ✅ Exportação CSV funcional
- ✅ CRUD de técnicos e veículos
- ✅ Gerenciamento de usuários

---

## Rodar localmente

```bash
npm install
npm start
# Acesse: http://localhost:3000
```

---

## Deploy no Render

1. Suba no GitHub:
```bash
git init
git add .
git commit -m "GestãoRotas v2"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/rotas-tecnicas.git
git push -u origin main
```

2. No Render (render.com):
   - New → Web Service
   - Conecte o repositório
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free

---

## Próximos passos (Next.js)

- [ ] Migrar para Next.js 14 + React
- [ ] Firebase Auth + Firestore em tempo real
- [ ] dnd-kit para drag and drop robusto
- [ ] Exportação PDF com jsPDF + html2canvas
- [ ] Rodízio automático via API ou tabela definitiva
- [ ] Feriados via BrasilAPI
