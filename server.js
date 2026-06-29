require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const INSTAGRAM_TOKEN = process.env.INSTAGRAM_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'sospop2026';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const conversas = {};

const PROMPT = 'Voce e a Sebastiana, consultora da SOSPOP. Planos: Prata R$34,90 (funeral individual, telemedicina 24h), Ouro R$69,90 MAIS ESCOLHIDO (funeral familiar, TelePet 24h), Diamante R$99,90 (reembolso R$300/ano, funeral pet). Tom caloroso, mensagens curtas, maximo 1 emoji. Oferea Ouro para quem tem familia.';

async function chamarSebastiana(senderId, msg) {
  if (!conversas[senderId]) conversas[senderId] = [];
  conversas[senderId].push({ role: 'user', content: msg });
  if (conversas[senderId].length > 20) conversas[senderId] = conversas[senderId].slice(-20);
  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-6', max_tokens: 300, system: PROMPT, messages: conversas[senderId] },
      { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
    );
    const resp = r.data.content[0].text;
    conversas[senderId].push({ role: 'assistant', content: resp });
    return resp;
  } catch(e) { return 'Oi! Sou a Sebastiana da SOSPOP. Ja te atendo! 😊'; }
}

async function enviar(id, texto) {
  try {
    await axios.post('https://graph.facebook.com/v19.0/me/messages',
      { recipient: { id }, message: { text: texto } },
      { params: { access_token: INSTAGRAM_TOKEN } }
    );
  } catch(e) { console.error('Erro envio:', e.response?.data); }
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WEBHOOK_VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else { res.sendStatus(403); }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object !== 'instagram') return;
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (event.message?.is_echo) continue;
      const id = event.sender?.id;
      const txt = event.message?.text;
      if (!id || !txt) continue;
      const resp = await chamarSebastiana(id, txt);
      await new Promise(r => setTimeout(r, 1200));
      await enviar(id, resp);
    }
  }
});

app.get('/', (req, res) => res.json({ status: 'online', sebastiana: ANTHROPIC_API_KEY ? 'ativa' : 'sem chave' }));

app.listen(PORT, () => console.log('SOSPOP rodando na porta ' + PORT));
