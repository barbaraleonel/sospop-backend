require('dotenv').config();
const express = require('express');
const axios = require('axios');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = process.env.RAILWAY_PUBLIC_DOMAIN ? 300 : (process.env.PORT || 3000);
const INSTAGRAM_TOKEN = process.env.INSTAGRAM_TOKEN;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'sospop2026';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const DEFAULT_WHATSAPP_SESSION_ID = process.env.WHATSAPP_CLIENT_ID || 'mex-atendimentos-1';
const whatsappSessions = new Map();

// ── Memória de conversas (em produção use banco de dados) ────────────────────
const conversas = {}; // { senderId: [{ role, content }] }

// ── Prompt da Sebastiana ─────────────────────────────────────────────────────
const PROMPT_ATENDENTE_MEX = `Você é a Atendente Mex, consultora comercial da Mex Atendimentos.

OBJETIVO:
Vender e qualificar interessados no sistema Mex Association OS, uma solução da Mex para associações, sindicatos, clubes, benefícios, convênios e operações com associados.

O QUE O SISTEMA ENTREGA:
- Cadastro e gestão de associados, dependentes, empresas conveniadas e atendimentos
- Painel administrativo para equipe, operadores e perfis de acesso
- Campanhas e disparos por WhatsApp/Instagram para prospecção e relacionamento
- Atendimento automatizado com IA e transferência para humano
- Controle de adesões, propostas, status, financeiro e relatórios
- Organização de benefícios, parcerias, planos e recorrência

PERSONALIDADE:
Clara, comercial, objetiva e próxima. Mensagens curtas. Não parecer robô. Fazer uma pergunta por vez.

ESTEIRA:
1. Cumprimente e entenda se a pessoa representa associação, sindicato, clube, empresa de benefícios ou operação comercial.
2. Descubra dor principal: cadastro bagunçado, atendimento manual, cobrança, campanhas, controle financeiro, WhatsApp, Instagram ou relatórios.
3. Explique o Mex Association OS conectando a dor a 2 ou 3 recursos.
4. Peça nome, cidade, entidade/empresa, quantidade aproximada de associados/clientes e telefone.
5. Se houver interesse, conduza para demonstração com humano.

REGRAS:
Nunca invente preço, prazo, integração garantida ou aprovação. Quando pedirem valor, contrato, implantação ou detalhes técnicos, diga que a equipe prepara a proposta e transfira para humano.`;

// ── Função: chamar Sebastiana (Claude) ──────────────────────────────────────
function respostaLocalAtendenteMex(mensagemUsuario = '') {
  const texto = String(mensagemUsuario).toLowerCase();
  if (texto.includes('preço') || texto.includes('valor') || texto.includes('quanto')) {
    return 'Consigo te ajudar sim. O valor depende do tamanho da operação e dos módulos que vocês precisam. Para preparar uma proposta certa, me diga: vocês são associação, sindicato, clube ou empresa de benefícios?';
  }

  if (texto.includes('whatsapp') || texto.includes('disparo') || texto.includes('campanha')) {
    return 'O Mex Association OS ajuda a organizar campanhas e atendimento por WhatsApp/Instagram, com contatos, status e transferência para humano. Hoje vocês fazem os disparos manualmente ou já usam alguma ferramenta?';
  }

  if (texto.includes('associado') || texto.includes('sindicato') || texto.includes('associação') || texto.includes('associacao')) {
    return 'Perfeito. O Mex Association OS centraliza associados, dependentes, convênios, adesões, financeiro e atendimento em um painel só. Quantos associados ou clientes vocês têm hoje, aproximadamente?';
  }

  return 'Olá! Sou a Atendente Mex. O Mex Association OS ajuda associações, sindicatos e operações de benefícios a organizar cadastros, atendimentos, campanhas, financeiro e relatórios em um só painel. Você representa uma associação, sindicato, clube ou empresa de benefícios?';
}

async function chamarAtendenteMex(senderId, mensagemUsuario, historico = []) {
  if (!conversas[senderId]) conversas[senderId] = [];
  
  const mensagens = historico.length ? historico : [{ role: 'user', content: mensagemUsuario }];
  conversas[senderId].push(...mensagens.filter((msg) => msg.role === 'user' || msg.role === 'assistant'));
  
  // Manter máximo 20 mensagens por conversa
  if (conversas[senderId].length > 20) {
    conversas[senderId] = conversas[senderId].slice(-20);
  }

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: PROMPT_ATENDENTE_MEX,
        messages: conversas[senderId]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const resposta = response.data.content[0].text;
    conversas[senderId].push({ role: 'assistant', content: resposta });
    return resposta;

  } catch (error) {
    console.error('Erro Anthropic:', error.response?.data || error.message);
    return respostaLocalAtendenteMex(mensagemUsuario);
  }
}

// ── Função: enviar mensagem pelo Instagram ───────────────────────────────────
async function enviarMensagemInstagram(recipientId, texto) {
  if (!INSTAGRAM_TOKEN || !INSTAGRAM_ACCOUNT_ID) {
    throw new Error('Instagram nao configurado: token ou account id ausente');
  }

  try {
    const response = await axios.post(
      `https://graph.instagram.com/v23.0/${INSTAGRAM_ACCOUNT_ID}/messages`,
      {
        recipient: { id: recipientId },
        message: { text: texto }
      },
      {
        params: { access_token: INSTAGRAM_TOKEN }
      }
    );
    console.log(`✅ Mensagem enviada para ${recipientId}: ${texto.substring(0, 50)}...`);
    return response.data;
  } catch (error) {
    const details = error.response?.data || error.message;
    console.error('Erro ao enviar mensagem Instagram:', JSON.stringify(details));
    throw error;
  }
}

function limparErroGraph(error) {
  const detail = error.response?.data || error.message;
  if (typeof detail !== 'object' || detail === null) return detail;
  return {
    error: detail.error ? {
      message: detail.error.message,
      type: detail.error.type,
      code: detail.error.code,
      error_subcode: detail.error.error_subcode,
      fbtrace_id: detail.error.fbtrace_id,
    } : undefined,
  };
}

function mapearConversaInstagram(conversa) {
  const participants = (conversa.participants?.data || []).map((participant) => ({
    id: participant.id,
    username: participant.username,
    name: participant.name,
  }));
  const lastMessage = conversa.messages?.data?.[0] || null;

  return {
    id: conversa.id,
    participants,
    lastMessage: lastMessage ? {
      id: lastMessage.id,
      message: lastMessage.message,
      created_time: lastMessage.created_time,
      from: lastMessage.from ? {
        id: lastMessage.from.id,
        username: lastMessage.from.username,
        name: lastMessage.from.name,
      } : null,
    } : null,
  };
}

function sanitizeSessionId(raw) {
  return String(raw || DEFAULT_WHATSAPP_SESSION_ID)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || DEFAULT_WHATSAPP_SESSION_ID;
}

function createWhatsappSession(sessionId, label) {
  const id = sanitizeSessionId(sessionId);
  if (!whatsappSessions.has(id)) {
    whatsappSessions.set(id, {
      id,
      label: label || id,
      client: null,
      status: 'desconectado',
      qrDataUrl: null,
      lastError: null,
      account: null,
      startedAt: null,
      sentCount: 0,
      lastSentAt: null,
    });
  } else if (label) {
    whatsappSessions.get(id).label = label;
  }
  return whatsappSessions.get(id);
}

function publicWhatsappStatus(session = createWhatsappSession()) {
  return {
    id: session.id,
    label: session.label,
    status: session.status,
    qrDataUrl: session.qrDataUrl,
    lastError: session.lastError,
    account: session.account,
    startedAt: session.startedAt,
    sentCount: session.sentCount,
    lastSentAt: session.lastSentAt,
  };
}

function publicWhatsappSessions() {
  return Array.from(whatsappSessions.values()).map(publicWhatsappStatus);
}

function ensureWhatsappClient(sessionId, label) {
  const session = createWhatsappSession(sessionId, label);
  if (session.client) return session.client;

  session.status = 'iniciando';
  session.lastError = null;
  session.startedAt = new Date().toISOString();

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: session.id }),
    puppeteer: {
      headless: true,
      executablePath: resolveChromeExecutable(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });
  session.client = client;

  client.on('qr', async (qr) => {
    session.status = 'aguardando_qr';
    session.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    session.lastError = null;
    console.log(`WhatsApp QR gerado para ${session.id}. Escaneie pelo painel.`);
  });

  client.on('authenticated', () => {
    session.status = 'autenticado';
    session.lastError = null;
  });

  client.on('ready', () => {
    session.status = 'conectado';
    session.qrDataUrl = null;
    session.lastError = null;
    const info = client.info || {};
    session.account = {
      wid: info.wid?._serialized || info.wid?.user || null,
      pushname: info.pushname || null,
      platform: info.platform || null,
    };
    console.log(`WhatsApp conectado (${session.id}):`, session.account);
  });

  client.on('auth_failure', (message) => {
    session.status = 'erro';
    session.lastError = message || 'Falha de autenticacao no WhatsApp';
  });

  client.on('disconnected', (reason) => {
    session.status = 'desconectado';
    session.qrDataUrl = null;
    session.lastError = reason || null;
    session.account = null;
    session.client = null;
    console.log(`WhatsApp desconectado (${session.id}):`, reason);
  });

  client.initialize().catch((error) => {
    session.status = 'erro';
    session.lastError = error.message;
    session.client = null;
    console.error(`Erro ao iniciar WhatsApp (${session.id}):`, error);
  });

  return client;
}

function normalizeBrazilPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('55') ? digits : `55${digits}`;
}

function resolveChromeExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Users/barbara/.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function encontrarImagemGemini(valor) {
  if (!valor || typeof valor !== 'object') return null;

  if (valor.output_image?.data) {
    return {
      data: valor.output_image.data,
      mimeType: valor.output_image.mime_type || valor.output_image.mimeType || 'image/png',
    };
  }

  if (valor.data && (valor.mime_type || valor.mimeType)) {
    return {
      data: valor.data,
      mimeType: valor.mime_type || valor.mimeType,
    };
  }

  if (Array.isArray(valor)) {
    for (const item of valor) {
      const imagem = encontrarImagemGemini(item);
      if (imagem) return imagem;
    }
    return null;
  }

  for (const item of Object.values(valor)) {
    const imagem = encontrarImagemGemini(item);
    if (imagem) return imagem;
  }

  return null;
}

// ── ROTA: Verificação do webhook (Meta exige isso na configuração) ────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`🔐 Verificação webhook: mode=${mode}, token=${token}`);

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado!');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Token inválido');
    res.sendStatus(403);
  }
});

// ── ROTA: Receber mensagens do Instagram ─────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Responde 200 imediatamente para a Meta não reenviar
  res.sendStatus(200);

  if (body.object !== 'instagram') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      
      // Ignorar mensagens enviadas por nós mesmos
      if (event.message?.is_echo) continue;
      
      const senderId = event.sender?.id;
      const texto = event.message?.text;

      if (!senderId || !texto) continue;

      console.log(`📩 DM recebida de ${senderId}: ${texto}`);

      const resposta = await chamarAtendenteMex(senderId, texto);
      
      // Pequena pausa para parecer natural (1-2 segundos)
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
      
      await enviarMensagemInstagram(senderId, resposta);
    }
  }
});

app.post('/api/chat', async (req, res) => {
  const senderId = String(req.body?.senderId || 'painel').trim();
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const lastUser = [...messages].reverse().find((msg) => msg.role === 'user')?.content || req.body?.message || '';

  if (!lastUser) {
    return res.status(400).json({ error: 'Mensagem obrigatoria.' });
  }

  try {
    const reply = await chamarAtendenteMex(senderId, lastUser, messages);
    res.json({ reply, product: 'Mex Association OS' });
  } catch (error) {
    res.status(500).json({ error: 'Falha ao responder chat', detail: error.message });
  }
});

app.post('/api/content', async (req, res) => {
  const channel = String(req.body?.channel || 'Instagram').trim();
  const type = String(req.body?.type || 'feed').trim();
  const topic = String(req.body?.topic || '').trim();

  if (!topic) {
    return res.status(400).json({ error: 'Envie topic.' });
  }

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 900,
        system: 'Especialista em marketing para MexPay. A MexPay ajuda MEIs, autonomos e pequenos comercios com maquininha, Pix, link de pagamento e cobranca digital. Nunca invente taxas, prazos ou aprovacao. Tom claro, comercial e direto. Responda SOMENTE com JSON valido, sem markdown, no formato: {"legenda":"texto completo com emojis e hashtags","cta":"chamada curta","hashtags":["#tag1","#tag2","#tag3","#tag4"],"horario":"HH:MM","motivo_horario":"1 frase","prompt_imagem":"descricao em ingles para gerar imagem publicitaria sem texto pequeno"}',
        messages: [{ role: 'user', content: `Crie ${type} para ${channel} sobre: ${topic}. Melhores horarios do perfil: 18h, 19h, 12h.` }],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        timeout: 30000,
      }
    );

    const raw = response.data.content?.[0]?.text || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    let content;
    try {
      content = JSON.parse(cleaned);
    } catch {
      content = { legenda: raw, cta: '', hashtags: [], horario: '18:00', motivo_horario: '', prompt_imagem: '' };
    }
    res.json(content);
  } catch (error) {
    const detail = error.response?.data?.error?.message || error.response?.data || error.message;
    console.error('Erro /api/content:', JSON.stringify(detail));
    res.status(error.response?.status || 500).json({ error: 'Falha ao gerar conteudo.', detail });
  }
});

app.get('/api/whatsapp/status', (req, res) => {
  const session = createWhatsappSession(req.query.sessionId);
  res.json(publicWhatsappStatus(session));
});

app.get('/api/whatsapp/sessions', (req, res) => {
  res.json({ sessions: publicWhatsappSessions() });
});

app.post('/api/whatsapp/start', (req, res) => {
  const session = createWhatsappSession(req.body?.sessionId, req.body?.label);
  ensureWhatsappClient(session.id, req.body?.label);
  res.json(publicWhatsappStatus(session));
});

app.post('/api/whatsapp/logout', async (req, res) => {
  const session = createWhatsappSession(req.body?.sessionId);
  if (session.client) {
    await session.client.logout().catch(() => {});
    await session.client.destroy().catch(() => {});
  }
  session.client = null;
  session.status = 'desconectado';
  session.qrDataUrl = null;
  session.lastError = null;
  session.account = null;
  res.json(publicWhatsappStatus(session));
});

app.post('/api/whatsapp/send', async (req, res) => {
  const session = createWhatsappSession(req.body?.sessionId);
  if (!session.client || session.status !== 'conectado') {
    return res.status(409).json({ error: 'WhatsApp ainda nao conectado. Escaneie o QR code primeiro.' });
  }

  const number = normalizeBrazilPhone(req.body?.number);
  const message = String(req.body?.message || '').trim();

  if (!number || number.length < 12) {
    return res.status(400).json({ error: 'Numero de WhatsApp invalido. Use DDD e numero.' });
  }

  if (!message) {
    return res.status(400).json({ error: 'Mensagem obrigatoria.' });
  }

  try {
    const chatId = `${number}@c.us`;
    const response = await session.client.sendMessage(chatId, message);
    session.sentCount += 1;
    session.lastSentAt = new Date().toISOString();
    res.json({ ok: true, sessionId: session.id, chatId, id: response.id?._serialized || response.id || null });
  } catch (error) {
    console.error('Erro ao enviar WhatsApp:', error.message);
    res.status(500).json({ error: 'Falha ao enviar WhatsApp', detail: error.message });
  }
});

app.post('/api/whatsapp/bulk-send', async (req, res) => {
  const numbers = Array.isArray(req.body?.numbers)
    ? req.body.numbers
    : String(req.body?.numbers || '').split(/[\n,;]+/);
  const message = String(req.body?.message || '').trim();
  const sessionIds = Array.isArray(req.body?.sessionIds) ? req.body.sessionIds.map(sanitizeSessionId) : [];
  const delayMs = Math.max(0, Math.min(Number(req.body?.delayMs || 1500), 30000));
  const cleanNumbers = numbers.map(normalizeBrazilPhone).filter((number) => number.length >= 12);
  const connected = publicWhatsappSessions()
    .filter((session) => session.status === 'conectado')
    .filter((session) => sessionIds.length === 0 || sessionIds.includes(session.id))
    .map((session) => whatsappSessions.get(session.id))
    .filter(Boolean);

  if (!message) {
    return res.status(400).json({ error: 'Mensagem obrigatoria.' });
  }

  if (cleanNumbers.length === 0) {
    return res.status(400).json({ error: 'Nenhum numero valido para disparo.' });
  }

  if (connected.length === 0) {
    return res.status(409).json({ error: 'Nenhum WhatsApp conectado para alternar o disparo.' });
  }

  const results = [];
  for (let index = 0; index < cleanNumbers.length; index += 1) {
    const session = connected[index % connected.length];
    const number = cleanNumbers[index];
    const chatId = `${number}@c.us`;
    try {
      const response = await session.client.sendMessage(chatId, message);
      session.sentCount += 1;
      session.lastSentAt = new Date().toISOString();
      results.push({
        ok: true,
        number,
        sessionId: session.id,
        id: response.id?._serialized || response.id || null,
      });
    } catch (error) {
      results.push({ ok: false, number, sessionId: session.id, error: error.message });
    }

    if (delayMs && index < cleanNumbers.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  res.json({
    ok: results.every((item) => item.ok),
    total: results.length,
    sent: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    sessions: connected.map(publicWhatsappStatus),
    results,
  });
});

app.get('/api/instagram/status', async (req, res) => {
  const config = {
    token: Boolean(INSTAGRAM_TOKEN),
    accountId: Boolean(INSTAGRAM_ACCOUNT_ID),
    accountIdValue: INSTAGRAM_ACCOUNT_ID ? `${String(INSTAGRAM_ACCOUNT_ID).slice(0, 5)}...` : null,
  };

  if (!INSTAGRAM_TOKEN || !INSTAGRAM_ACCOUNT_ID) {
    return res.json({ ok: false, config, error: 'Token ou account id ausente no backend.' });
  }

  try {
    const account = await axios.get(
      `https://graph.instagram.com/v23.0/${INSTAGRAM_ACCOUNT_ID}`,
      {
        params: {
          fields: 'id,username,name',
          access_token: INSTAGRAM_TOKEN,
        },
      }
    );
    res.json({ ok: true, config, account: account.data });
  } catch (error) {
    const detail = error.response?.data || error.message;
    res.status(400).json({ ok: false, config, error: 'Falha ao validar conta Instagram', detail });
  }
});

app.get('/api/instagram/conversations', async (req, res) => {
  if (!INSTAGRAM_TOKEN || !INSTAGRAM_ACCOUNT_ID) {
    return res.json({ ok: false, conversations: [], error: 'Token ou account id ausente no backend.' });
  }

  try {
    const response = await axios.get(
      `https://graph.instagram.com/v23.0/${INSTAGRAM_ACCOUNT_ID}/conversations`,
      {
        params: {
          platform: 'instagram',
          fields: 'id,participants,messages.limit(1){id,message,from,created_time}',
          limit: 20,
          access_token: INSTAGRAM_TOKEN,
        },
      }
    );

    res.json({
      ok: true,
      total: response.data?.data?.length || 0,
      conversations: (response.data?.data || []).map(mapearConversaInstagram),
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      conversations: [],
      error: 'Falha ao buscar conversas Instagram',
      detail: limparErroGraph(error),
    });
  }
});

app.post('/api/instagram/test', async (req, res) => {
  const recipientId = String(req.body?.recipientId || '').trim();
  const text = String(req.body?.text || '').trim();

  if (!recipientId) {
    return res.status(400).json({ error: 'Informe o recipient ID do Instagram.' });
  }

  if (!text) {
    return res.status(400).json({ error: 'Mensagem obrigatoria.' });
  }

  try {
    const response = await enviarMensagemInstagram(recipientId, text);
    res.json({ ok: true, response });
  } catch (error) {
    const detail = limparErroGraph(error);
    res.status(400).json({ ok: false, error: 'Falha ao enviar teste Instagram', detail });
  }
});

app.post('/api/image', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY nao configurada' });
  }

  const prompt = String(req.body?.prompt || '').trim();
  const model = String(req.body?.model || GEMINI_IMAGE_MODEL).trim();

  if (!prompt) {
    return res.status(400).json({ error: 'prompt obrigatorio' });
  }

  try {
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      {
        model,
        input: [
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
      }
    );

    const imagem = encontrarImagemGemini(response.data);

    if (!imagem?.data) {
      return res.status(502).json({
        error: 'Gemini nao retornou imagem',
        detail: response.data?.error?.message,
      });
    }

    res.json({
      model,
      mimeType: imagem.mimeType,
      imageBase64: imagem.data,
      dataUrl: `data:${imagem.mimeType};base64,${imagem.data}`,
    });
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error('Erro Gemini imagem:', JSON.stringify(detail));
    res.status(500).json({
      error: 'Falha ao gerar imagem no Gemini',
      detail,
    });
  }
});

// ── ROTA: Health check ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    sistema: 'SOSPOP Omnichannel Backend',
    sebastiana: ANTHROPIC_API_KEY ? 'ativa' : 'sem chave API',
    gemini_imagem: GEMINI_API_KEY ? 'configurado' : 'sem chave',
    gemini_image_model: GEMINI_IMAGE_MODEL,
    instagram: INSTAGRAM_TOKEN ? 'configurado' : 'sem token',
    instagram_account_id: INSTAGRAM_ACCOUNT_ID ? 'configurado' : 'sem account id',
    conversas_ativas: Object.keys(conversas).length
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'sospop-backend' });
});

// ── ROTA: Diagnostico sem expor segredos ──────────────────────────────────────
app.get('/debug/config', (req, res) => {
  res.json({
    anthropic: Boolean(ANTHROPIC_API_KEY),
    gemini: Boolean(GEMINI_API_KEY),
    gemini_image_model: GEMINI_IMAGE_MODEL,
    instagram_token: Boolean(INSTAGRAM_TOKEN),
    instagram_account_id: Boolean(INSTAGRAM_ACCOUNT_ID),
    webhook_verify_token: Boolean(WEBHOOK_VERIFY_TOKEN)
  });
});

// ── ROTA: Ver conversas ativas ────────────────────────────────────────────────
app.get('/conversas', (req, res) => {
  const resumo = Object.entries(conversas).map(([id, msgs]) => ({
    usuario: id,
    total_mensagens: msgs.length,
    ultima: msgs[msgs.length - 1]?.content?.substring(0, 80)
  }));
  res.json({ total: resumo.length, conversas: resumo });
});

// ── Iniciar servidor ──────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   SOSPOP Omnichannel Backend           ║
║   Porta: ${PORT}                          ║
║   Sebastiana: ${ANTHROPIC_API_KEY ? '✅ Ativa' : '❌ Sem chave'}              ║
║   Instagram: ${INSTAGRAM_TOKEN ? '✅ Configurado' : '❌ Sem token'}          ║
╚════════════════════════════════════════╝
  `);
});
