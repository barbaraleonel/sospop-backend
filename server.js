require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '1mb' }));

const FRONTEND_ORIGINS = [
  'https://sospop-cap.web.app',
  'https://sospop-cap.firebaseapp.com',
  'http://localhost:3000'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || FRONTEND_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = Number(process.env.SOSPOP_PORT || process.env.PORT || 3000);
const INSTAGRAM_TOKEN = (process.env.INSTAGRAM_TOKEN || '').trim();
const INSTAGRAM_ACCOUNT_ID = (process.env.INSTAGRAM_ACCOUNT_ID || '').trim();
const WEBHOOK_VERIFY_TOKEN = (process.env.WEBHOOK_VERIFY_TOKEN || 'sospop2026').trim();
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const CLAUDE_MODEL = (process.env.CLAUDE_MODEL || 'claude-sonnet-4-6').trim();

const conversas = {};

const PROMPT_SEBASTIANA = `Voce e a Sebastiana, consultora de vendas da SOSPOP - Beneficios e Protecao Familiar.

PLANOS (valores EXATOS - nunca invente):
PRATA R$ 34,90/mes: funeral individual, clube DU, telemedicina 24h
OURO R$ 69,90/mes (MAIS ESCOLHIDO): funeral familiar, apoio despedida, TelePet 24h
DIAMANTE R$ 99,90/mes: reembolso med/pet R$300/ano, funeral pet, tudo do Ouro+

Cobertura familiar: Titular, Conjuge, Pai, Mae, Sogro, Sogra, Filhos.

PERSONALIDADE: calorosa, proxima, direta. Nunca corporativa.
Mensagens curtas (2-3 linhas). Maximo 1 emoji por mensagem.

ESTEIRA: saudacao pelo nome, qualificacao familia/pet, apresentacao do plano ideal, ancoragem de valor, objecoes, fechamento, proximo passo.

REGRAS: nunca minta sobre coberturas. Se pedir humano ou reclamar, transfira. Ofereca Ouro como primeira opcao para quem tem familia.`;

function publicAnthropicError(error) {
  const data = error.response?.data;
  return data?.error?.message || data?.message || error.message || 'Erro desconhecido';
}

async function chamarClaude({ system, messages, maxTokens = 500 }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY nao configurada');
    err.status = 503;
    throw err;
  }

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system,
      messages
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      timeout: 30000
    }
  );

  return response.data.content?.[0]?.text || '';
}

async function chamarSebastiana(senderId, msg) {
  if (!conversas[senderId]) conversas[senderId] = [];
  conversas[senderId].push({ role: 'user', content: msg });
  if (conversas[senderId].length > 20) conversas[senderId] = conversas[senderId].slice(-20);

  const resp = await chamarClaude({
    system: PROMPT_SEBASTIANA,
    messages: conversas[senderId],
    maxTokens: 300
  });

  conversas[senderId].push({ role: 'assistant', content: resp });
  return resp;
}

async function enviar(id, texto) {
  if (!INSTAGRAM_TOKEN || !INSTAGRAM_ACCOUNT_ID) {
    console.error('Instagram nao configurado: token ou account id ausente');
    return;
  }

  try {
    await axios.post(
      `https://graph.instagram.com/v23.0/${INSTAGRAM_ACCOUNT_ID}/messages`,
      { recipient: { id }, message: { text: texto } },
      { params: { access_token: INSTAGRAM_TOKEN }, timeout: 30000 }
    );
    console.log(`Mensagem Instagram enviada para ${id}`);
  } catch (e) {
    console.error('Erro envio Instagram:', JSON.stringify(e.response?.data || e.message));
  }
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WEBHOOK_VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
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

      console.log(`DM Instagram recebida de ${id}`);
      try {
        const resp = await chamarSebastiana(id, txt);
        await new Promise(r => setTimeout(r, 1200));
        await enviar(id, resp);
      } catch (e) {
        console.error('Erro Sebastiana webhook:', JSON.stringify(e.response?.data || e.message));
      }
    }
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { senderId = 'painel-demo', message, messages, contact, channel } = req.body || {};
    const text = String(message || '').trim();
    if (!text && !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Envie message ou messages.' });
    }

    const context = [
      contact?.name ? `Contato: ${contact.name}` : '',
      Array.isArray(contact?.tags) && contact.tags.length ? `Interesses: ${contact.tags.join(', ')}` : '',
      channel ? `Canal: ${channel}` : ''
    ].filter(Boolean).join('\n');

    const normalizedMessages = Array.isArray(messages)
      ? messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || m.text || '') })).filter(m => m.content)
      : [{ role: 'user', content: text }];

    const reply = await chamarClaude({
      system: context ? `${PROMPT_SEBASTIANA}\n\n${context}` : PROMPT_SEBASTIANA,
      messages: normalizedMessages,
      maxTokens: 350
    });

    if (!conversas[senderId]) conversas[senderId] = [];
    conversas[senderId].push(...normalizedMessages.slice(-1));
    conversas[senderId].push({ role: 'assistant', content: reply });

    res.json({ reply });
  } catch (e) {
    const detail = publicAnthropicError(e);
    console.error('Erro /api/chat:', JSON.stringify(e.response?.data || e.message));
    res.status(e.status || e.response?.status || 500).json({ error: e.status === 503 ? e.message : 'Falha ao chamar a Sebastiana.', detail });
  }
});

app.post('/api/content', async (req, res) => {
  try {
    const { channel = 'Instagram', type = 'feed', topic } = req.body || {};
    const cleanTopic = String(topic || '').trim();
    if (!cleanTopic) return res.status(400).json({ error: 'Envie topic.' });

    const system = 'Especialista em marketing para SOSPOP. Planos: Prata R$34,90 (funeral individual, clube DU, telemedicina 24h), Ouro R$69,90 MAIS ESCOLHIDO (funeral familiar, TelePet 24h), Diamante R$99,90 (reembolso R$300/ano, funeral pet). Publico: familias e pets em MS. Tom proximo e caloroso. Responda SOMENTE com JSON valido, sem markdown, no formato: {"legenda":"texto completo com emojis e hashtags","cta":"chamada curta","hashtags":["#tag1","#tag2","#tag3","#tag4"],"horario":"HH:MM","motivo_horario":"1 frase","prompt_imagem":"descricao em ingles para DALL-E"}';

    const raw = await chamarClaude({
      system,
      messages: [{ role: 'user', content: `Crie ${type} para ${channel} sobre: ${cleanTopic}. Melhores horarios do perfil: 18h, 19h, 12h.` }],
      maxTokens: 900
    });

    const cleaned = raw.replace(/```json|```/g, '').trim();
    let content;
    try {
      content = JSON.parse(cleaned);
    } catch {
      content = { legenda: raw, cta: '', hashtags: [], horario: '18:00', motivo_horario: '', prompt_imagem: '' };
    }

    res.json(content);
  } catch (e) {
    const detail = publicAnthropicError(e);
    console.error('Erro /api/content:', JSON.stringify(e.response?.data || e.message));
    res.status(e.status || e.response?.status || 500).json({ error: e.status === 503 ? e.message : 'Falha ao gerar conteudo.', detail });
  }
});

app.get('/conversas', (req, res) => {
  const resumo = Object.entries(conversas).map(([id, msgs]) => ({
    usuario: id,
    total_mensagens: msgs.length,
    ultima: msgs[msgs.length - 1]?.content?.substring(0, 80)
  }));
  res.json({ total: resumo.length, conversas: resumo });
});

app.get('/debug/config', (req, res) => res.json({
  anthropic: Boolean(ANTHROPIC_API_KEY),
  instagram_token: Boolean(INSTAGRAM_TOKEN),
  instagram_account_id: Boolean(INSTAGRAM_ACCOUNT_ID),
  webhook_verify_token: Boolean(WEBHOOK_VERIFY_TOKEN)
}));

app.get('/', (req, res) => res.json({
  status: 'online',
  sistema: 'SOSPOP Omnichannel Backend',
  sebastiana: ANTHROPIC_API_KEY ? 'ativa' : 'sem chave',
  instagram: INSTAGRAM_TOKEN ? 'configurado' : 'sem token',
  instagram_account_id: INSTAGRAM_ACCOUNT_ID ? 'configurado' : 'sem account id',
  conversas_ativas: Object.keys(conversas).length
}));

app.listen(PORT, '0.0.0.0', () => console.log('SOSPOP rodando na porta ' + PORT));
