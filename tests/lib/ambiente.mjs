// Ambientes de teste: Firebase (emuladores oficiais) e Supabase (supabase start local)
import { initializeApp as fbInit, deleteApp } from 'firebase/app';
import * as fbAuth from 'firebase/auth';
import * as fbFs from 'firebase/firestore';
import { createClient } from '@supabase/supabase-js';
import * as shim from '../../supabase-firestore.js';

export const FB_PROJETO = 'demo-rotas';
export const FS_HOST = '127.0.0.1', FS_PORTA = 8080, AUTH_PORTA = 9099;

export const SB = {
  url: process.env.SB_URL || 'http://127.0.0.1:54321',
  anonKey: process.env.SB_ANON || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  serviceKey: process.env.SB_SERVICE || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
};

export const sbAdmin = () => createClient(SB.url, SB.serviceKey, { auth: { persistSession: false } });

// ── Limpeza ──────────────────────────────────────────────────────────────────
export async function limparFirestore() {
  const r = await fetch(`http://${FS_HOST}:${FS_PORTA}/emulator/v1/projects/${FB_PROJETO}/databases/(default)/documents`, { method: 'DELETE' });
  if (!r.ok) throw new Error('falha ao limpar firestore: ' + r.status);
}
export async function limparFirebaseAuth() {
  await fetch(`http://${FS_HOST}:${AUTH_PORTA}/emulator/v1/projects/${FB_PROJETO}/accounts`, { method: 'DELETE' });
}
export async function limparSupabase() {
  const { error } = await sbAdmin().from('documentos').delete().gte('id', '');
  if (error) throw error;
}
export async function limparSupabaseAuth() {
  const adm = sbAdmin();
  const { data } = await adm.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users) await adm.auth.admin.deleteUser(u.id);
}

export async function garantirUsuarioSupabase(email, senha, meta = {}) {
  const adm = sbAdmin();
  const { data } = await adm.auth.admin.listUsers({ perPage: 1000 });
  const existente = data.users.find(u => u.email === email.toLowerCase());
  if (existente) {
    await adm.auth.admin.updateUserById(existente.id, { password: senha });
    return existente.id;
  }
  const { data: c, error } = await adm.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: meta });
  if (error) throw error;
  return c.user.id;
}

export async function garantirUsuarioFirebase(email, senha) {
  const base = `http://${FS_HOST}:${AUTH_PORTA}/identitytoolkit.googleapis.com/v1/accounts`;
  const post = (acao, corpo) => fetch(`${base}:${acao}?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...corpo, returnSecureToken: true }),
  }).then(r => r.json());
  const j = await post('signUp', { email, password: senha });
  if (j.localId) return j.localId;
  if (j.error?.message === 'EMAIL_EXISTS') return (await post('signInWithPassword', { email, password: senha })).localId;
  throw new Error(JSON.stringify(j));
}

// ── Clientes com a mesma forma de window._FB ────────────────────────────────
let _n = 0;
export async function clienteFirebase() {
  const app = fbInit({ apiKey: 'fake', projectId: FB_PROJETO, authDomain: 'localhost' }, `fb${++_n}`);
  const auth = fbAuth.getAuth(app);
  fbAuth.connectAuthEmulator(auth, `http://${FS_HOST}:${AUTH_PORTA}`, { disableWarnings: true });
  const db = fbFs.getFirestore(app);
  fbFs.connectFirestoreEmulator(db, FS_HOST, FS_PORTA);
  return { nome: 'firebase', auth, db, ...fbAuth, ...fbFs, fechar: () => deleteApp(app) };
}

export async function clienteSupabase({ email = 'teste@rotas.dev', senha = 'senha123' } = {}) {
  await garantirUsuarioSupabase(email, senha);
  const app = shim.initializeApp({ url: SB.url, anonKey: SB.anonKey, createClient, persistSession: false, detectSessionInUrl: false });
  const auth = shim.getAuth(app);
  const db = shim.getFirestore(app);
  await shim.signInWithEmailAndPassword(auth, email, senha);
  return {
    nome: 'supabase', auth, db, ...shim, _app: app,
    fechar: async () => { await app._client.removeAllChannels(); await app._client.auth.signOut().catch(() => {}); },
  };
}

export const esperar = ms => new Promise(r => setTimeout(r, ms));
export async function ate(cond, { timeout = 8000, passo = 50, msg = 'condição' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout esperando ' + msg);
    await esperar(passo);
  }
}
