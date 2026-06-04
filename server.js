const express = require('express');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');
const crypto = require('crypto');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Configuracoes
const EFIPAY_CLIENT_ID = process.env.EFIPAY_CLIENT_ID;
const EFIPAY_CLIENT_SECRET = process.env.EFIPAY_CLIENT_SECRET;
const EFIPAY_CERTIFICATE_BASE64 = process.env.EFIPAY_CERTIFICATE_BASE64;
const EFIPAY_ENV = process.env.EFIPAY_ENV || 'sandbox';
const RELAY_SECRET = process.env.RELAY_SECRET;
const PIX_KEY = process.env.PIX_KEY;
const WEBHOOK_FORWARD_URL = process.env.WEBHOOK_FORWARD_URL;

const isSandbox = EFIPAY_ENV === 'sandbox';
const EFIPAY_BASE = isSandbox
  ? 'https://pix-h.api.efipay.com.br'
  : 'https://pix.api.efipay.com.br';
const OAUTH_URL = isSandbox
  ? 'https://sandbox-api.efipay.com.br'
  : 'https://api.efipay.com.br';

// Agente mTLS
let agent = null;
function getAgent() {
  if (agent) return agent;
  if (!EFIPAY_CERTIFICATE_BASE64) return new https.Agent();
  const p12Buffer = Buffer.from(EFIPAY_CERTIFICATE_BASE64, 'base64');
  agent = new https.Agent({
    pfx: p12Buffer,
    passphrase: '',
    rejectUnauthorized: !isSandbox,
  });
  return agent;
}

// Cache de token OAuth
let tokenCache = { access_token: null, expires_at: 0 };
async function getOAuthToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.expires_at - 60000) {
    return tokenCache.access_token;
  }
  const auth = Buffer.from(`${EFIPAY_CLIENT_ID}:${EFIPAY_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    `${OAUTH_URL}/v1/authorize`,
    { grant_type: 'client_credentials' },
    {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      httpsAgent: getAgent(),
    }
  );
  tokenCache = {
    access_token: res.data.access_token,
    expires_at: now + (res.data.expires_in * 1000),
  };
  return tokenCache.access_token;
}

// Middleware de autenticacao do relay
function requireRelaySecret(req, res, next) {
  const auth = req.headers['x-relay-secret'];
  if (!auth || auth !== RELAY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ============================================
// ENDPOINTS
// ============================================

// 1. Criar cobranca PIX dinamica + QR Code
app.post('/pix/charge', requireRelaySecret, async (req, res) => {
  try {
    const { valor, descricao, txid } = req.body;
    if (!valor || !descricao) {
      return res.status(400).json({ error: 'valor e descricao sao obrigatorios' });
    }
    const token = await getOAuthToken();
    const payload = {
      calendario: { expiracao: 3600 },
      devedor: { cpf: '00000000000', nome: 'Pagador' },
      valor: { original: parseFloat(valor).toFixed(2) },
      chave: PIX_KEY,
      solicitacaoPagador: descricao,
      ...(txid ? { txid } : {}),
    };
    const response = await axios.post(`${EFIPAY_BASE}/v2/cob`, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      httpsAgent: getAgent(),
    });
    const cobranca = response.data;

    // Gerar QR Code
    const qrRes = await axios.get(`${EFIPAY_BASE}/v2/loc/${cobranca.loc.id}/qrcode`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      httpsAgent: getAgent(),
    });

    res.json({
      txid: cobranca.txid,
      location: cobranca.loc.id,
      qrCode: qrRes.data.qrcode,
      qrCodeImage: qrRes.data.imagemQrcode,
      pixCopyPaste: qrRes.data.qrcode,
      valor: cobranca.valor.original,
      expiracao: cobranca.calendario.expiracao,
    });
  } catch (err) {
    console.error('Erro ao criar cobranca:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Erro ao criar cobranca PIX',
      details: err.response?.data || err.message,
    });
  }
});

// 2. Consultar status da cobranca
app.get('/pix/charge/:txid', requireRelaySecret, async (req, res) => {
  try {
    const token = await getOAuthToken();
    const response = await axios.get(`${EFIPAY_BASE}/v2/cob/${req.params.txid}`, {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent: getAgent(),
    });
    const cob = response.data;
    res.json({
      txid: cob.txid,
      status: cob.status,
      valor: cob.valor.original,
      pixRecebidos: cob.pix || [],
    });
  } catch (err) {
    console.error('Erro ao consultar:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Erro ao consultar cobranca',
      details: err.response?.data || err.message,
    });
  }
});

// 3. Configurar webhook
app.post('/pix/webhook-config', requireRelaySecret, async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    const token = await getOAuthToken();
    const response = await axios.put(
      `${EFIPAY_BASE}/v2/webhook/${PIX_KEY}`,
      { webhookUrl: webhookUrl || WEBHOOK_FORWARD_URL },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-skip-mtls-checking': 'true',
        },
        httpsAgent: getAgent(),
      }
    );
    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error('Erro webhook-config:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Erro ao configurar webhook',
      details: err.response?.data || err.message,
    });
  }
});

// 4. Receber webhook da Efí e encaminhar para Lovable
app.post('/pix/webhook*', async (req, res) => {
  try {
    console.log('Webhook recebido da Efi:', JSON.stringify(req.body));
    if (!WEBHOOK_FORWARD_URL) {
      return res.status(200).json({ ok: true, message: 'No forward URL configured' });
    }
    await axios.post(WEBHOOK_FORWARD_URL, req.body, {
      headers: { 'Content-Type': 'application/json' },
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro ao encaminhar webhook:', err.message);
    res.status(200).json({ ok: true, forwarded: false });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', env: EFIPAY_ENV });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FLOPASS EFI Relay rodando na porta ${PORT} | Env: ${EFIPAY_ENV}`);
});
