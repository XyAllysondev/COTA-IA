const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();

function updateEnv(updates) {
  const file = path.join(__dirname, '.env');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
    const idx = lines.findIndex(l => l.match(new RegExp(`^\\s*${key}\\s*=`)));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(file, lines.join('\n'));
}

async function handleOAuthCallback(url, res) {
  const code = url.searchParams.get('code');
  if (!code) return send(res, 400, 'Faltou o parâmetro "code" no redirect.', 'text/plain; charset=utf-8');
  try {
    const response = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.MERCADO_LIVRE_CLIENT_ID,
        client_secret: process.env.MERCADO_LIVRE_CLIENT_SECRET,
        code,
        redirect_uri: process.env.MERCADO_LIVRE_REDIRECT_URI
      })
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) {
      console.error('OAuth Mercado Livre:', data);
      return send(res, 502, `Falha ao gerar token: ${JSON.stringify(data)}`, 'text/plain; charset=utf-8');
    }
    updateEnv({ MERCADO_LIVRE_ACCESS_TOKEN: data.access_token, MERCADO_LIVRE_REFRESH_TOKEN: data.refresh_token || '' });
    console.log('Token do Mercado Livre gravado no .env com sucesso.');
    send(res, 200, '<h1>Token gerado com sucesso!</h1><p>Ja pode fechar esta aba. O .env foi atualizado.</p>', 'text/html; charset=utf-8');
  } catch (error) {
    console.error(error);
    send(res, 500, 'Erro inesperado ao trocar o code pelo token.', 'text/plain; charset=utf-8');
  }
}

const root = __dirname;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const searchCache = new Map();

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 10_000) throw new Error('Solicitação muito grande.');
  }
  return JSON.parse(data || '{}');
}

async function createPreference(req, res) {
  if (!process.env.MERCADO_PAGO_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN.includes('COLE_')) {
    return send(res, 503, { error: 'Configure MERCADO_PAGO_ACCESS_TOKEN no arquivo .env antes de usar pagamentos.' });
  }
  try {
    const { title, unitPrice, quantity = 1 } = await readJson(req);
    const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 120) : '';
    const price = Number(unitPrice);
    const qty = Number(quantity);
    if (!cleanTitle || !Number.isFinite(price) || price <= 0 || price > 50000 || !Number.isInteger(qty) || qty < 1 || qty > 10) {
      return send(res, 400, { error: 'Dados de pagamento inválidos.' });
    }

    const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, '');
    const preference = {
      items: [{ title: cleanTitle, quantity: qty, currency_id: 'BRL', unit_price: Number(price.toFixed(2)) }],
      payment_methods: { installments: 12 },
      external_reference: crypto.randomUUID(),
      ...(baseUrl ? { back_urls: { success: `${baseUrl}/?payment=success`, pending: `${baseUrl}/?payment=pending`, failure: `${baseUrl}/?payment=failure` }, auto_return: 'approved' } : {})
    };
    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(preference)
    });
    const result = await response.json();
    if (!response.ok || !result.init_point) {
      console.error('Mercado Pago:', result);
      return send(res, 502, { error: 'Não foi possível iniciar o checkout. Verifique sua credencial do Mercado Pago.' });
    }
    send(res, 201, { checkoutUrl: result.init_point });
  } catch (error) {
    console.error(error);
    send(res, 400, { error: 'Não foi possível processar a solicitação de pagamento.' });
  }
}

// Preços reais do Mercado Livre estão bloqueados (403). Enquanto isso, agregamos
// várias APIs públicas de catálogo. Preços em US$ convertidos para R$ só para exibição.
// Para dados reais, adicione aqui uma fonte com chave (ex.: SerpAPI/Google Shopping).
const USD_TO_BRL = 5.4;
const toBrl = usd => Number((Number(usd) * USD_TO_BRL).toFixed(2));

async function fetchJson(target, timeoutMs = 3500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(target, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const priceSources = [
  {
    // Fonte REAL e global: Google Shopping via SerpAPI. Ativa só quando há SERPAPI_KEY no .env.
    // Preços já vêm em R$ (gl=br), então não convertemos.
    name: 'Google Shopping',
    real: true,
    enabled: () => process.env.SERPAPI_KEY && !process.env.SERPAPI_KEY.includes('COLE_'),
    async run(query) {
      const u = new URL('https://serpapi.com/search.json');
      u.searchParams.set('engine', 'google_shopping');
      u.searchParams.set('q', query);
      u.searchParams.set('gl', 'br');
      u.searchParams.set('hl', 'pt');
      u.searchParams.set('location', 'Brazil');
      u.searchParams.set('api_key', process.env.SERPAPI_KEY);
      const data = await fetchJson(u, 6000);
      if (data.error) {
        if (/hasn't returned any results|no results/i.test(data.error)) return [];
        throw new Error(data.error);
      }
      return (data.shopping_results || [])
        .filter(i => Number(i.extracted_price) > 0)
        .map(i => ({ id: `gs-${i.product_id || i.position}`, store: i.source || 'Google Shopping', title: i.title, price: Number(i.extracted_price), url: i.product_link || i.link }));
    }
  },
  {
    name: 'DummyJSON',
    demo: true,
    async run(query) {
      const data = await fetchJson(`https://dummyjson.com/products/search?q=${encodeURIComponent(query)}&limit=20`);
      return (data.products || []).map(i => ({ id: `dj-${i.id}`, store: i.brand || 'DummyJSON', title: i.title, price: toBrl(i.price), url: `https://dummyjson.com/products/${i.id}` }));
    }
  },
  {
    name: 'Platzi',
    demo: true,
    async run(query) {
      const data = await fetchJson(`https://api.escuelajs.co/api/v1/products/?title=${encodeURIComponent(query)}&limit=20&offset=0`);
      return (Array.isArray(data) ? data : []).map(i => ({ id: `pz-${i.id}`, store: i.category?.name || 'Platzi Store', title: i.title, price: toBrl(i.price), url: `https://api.escuelajs.co/api/v1/products/${i.id}` }));
    }
  },
  {
    name: 'FakeStore',
    demo: true,
    async run(query) {
      const data = await fetchJson('https://fakestoreapi.com/products');
      const q = query.toLowerCase();
      return (Array.isArray(data) ? data : [])
        .filter(i => i.title.toLowerCase().includes(q) || (i.category || '').toLowerCase().includes(q))
        .map(i => ({ id: `fs-${i.id}`, store: i.category || 'FakeStore', title: i.title, price: toBrl(i.price), url: `https://fakestoreapi.com/products/${i.id}` }));
    }
  }
];

function filterOffersByIntent(offers, query) {
  const normalized = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const isXboxConsole = normalized.includes('xbox') && /\b(console|videogame|video game)\b/.test(normalized);
  if (!isXboxConsole) return offers;

  const accessory = /\b(capa|case|skin|pelicula|suporte|base|controle|joystick|carregador|cabo|adaptador|jogo|game pass|headset|fone)\b/i;
  const consoleHardware = /\b(console|xbox\s*(series|one)|series\s*[sx]|series\s*x|series\s*s)\b/i;
  return offers.filter(offer => consoleHardware.test(offer.title) && !accessory.test(offer.title));
}

// Se alguma fonte real (com chave) estiver ativa, usamos só as reais e escondemos as de demonstração.
function activePriceSources() {
  const usable = priceSources.filter(s => !s.enabled || s.enabled());
  const hasReal = usable.some(s => s.real);
  return hasReal ? usable.filter(s => !s.demo) : usable;
}

// Núcleo da busca, reutilizável pelo endpoint HTTP e pelo agente de IA.
async function runSearch({ query, onlyFreeShipping = false, maxPrice = NaN }) {
  query = (query || '').trim().slice(0, 120);
  if (!query) return { error: 'Informe o item que deseja pesquisar.' };
  const cacheKey = `${query}|${onlyFreeShipping}|${maxPrice || ''}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 5 * 60 * 1000) return { ...cached.payload, cached: true };
  const sources = activePriceSources();
  const results = await Promise.allSettled(sources.map(s => s.run(query)));
  const sourcesUsed = [];
  let offers = [];
  results.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      if (result.value.length) sourcesUsed.push(sources[idx].name);
      offers = offers.concat(result.value.map(o => ({ ...o, source: sources[idx].name })));
    } else {
      console.error(`Fonte ${sources[idx].name} falhou:`, result.reason?.message);
    }
  });

  const seen = new Set();
  offers = filterOffersByIntent(offers, query)
    .map(o => ({ ...o, currency: 'BRL', condition: 'Novo', freeShipping: o.price > 300 }))
    .filter(o => { const key = `${o.title.toLowerCase()}|${o.price}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .filter(o => !Number.isFinite(maxPrice) || maxPrice <= 0 || o.price <= maxPrice)
    .filter(o => !onlyFreeShipping || o.freeShipping)
    .sort((a, b) => a.price - b.price)
    .slice(0, 8);

  if (!sourcesUsed.length && !offers.length && results.every(r => r.status === 'rejected')) {
    return { error: 'Nenhuma fonte de preços respondeu agora. Tente novamente em alguns instantes.' };
  }
  const payload = {
    source: sourcesUsed.length ? `Agregado: ${sourcesUsed.join(', ')}` : 'Nenhum resultado encontrado',
    queriedAt: new Date().toISOString(),
    offers
  };
  searchCache.set(cacheKey, { createdAt: Date.now(), payload });
  return payload;
}

async function searchMercadoLivre(url, res) {
  const payload = await runSearch({
    query: url.searchParams.get('q'),
    onlyFreeShipping: url.searchParams.get('free_shipping') === 'true',
    maxPrice: Number(url.searchParams.get('max_price'))
  });
  send(res, payload.error ? (payload.error.startsWith('Informe') ? 400 : 502) : 200, payload);
}

// Agente de IA: interpreta o pedido em linguagem natural, usa a busca de preços
// como ferramenta (function calling) e recomenda. Usa o Google Gemini (plano
// gratuito), via HTTP, no mesmo padrão de fetch do resto do projeto.
const GEMINI_MODEL = 'gemini-flash-latest';
const ASSISTANT_TOOLS = [{
  function_declarations: [{
    name: 'buscar_produtos',
    description: 'Busca produtos e preços reais em lojas. Use sempre que o usuário quiser encontrar, comparar ou saber o preço de algum produto.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Termo de busca do produto, ex: "geladeira frost free", "tênis nike corrida".' },
        maxPrice: { type: 'NUMBER', description: 'Preço máximo em reais, se o usuário mencionar um limite.' },
        freeShipping: { type: 'BOOLEAN', description: 'true se o usuário exigir frete grátis.' }
      },
      required: ['query']
    }
  }]
}];
const ASSISTANT_SYSTEM = 'Você é a CotaIA, uma assistente de compras brasileira. Ajude a pessoa a encontrar produtos e os melhores preços. '
  + 'Sempre use a ferramenta buscar_produtos para obter preços reais antes de recomendar — nunca invente preços. '
  + 'Entenda a intenção do produto: se a pessoa pedir um console, não recomende capas, controles, jogos, cabos ou outros acessórios; se pedir o produto principal, priorize o produto principal. '
  + 'Depois de buscar, responda em português do Brasil, de forma curta e objetiva: destaque a melhor opção, o motivo, e cite 1 ou 2 alternativas com o preço em R$. Se não achar nada, diga com franqueza.';

async function openRouterFallback(userMessage) {
  if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY.includes('COLE_')) return null;
  const search = await runSearch({ query: userMessage });
  const offers = search.offers || [];
  const offerContext = offers.length
    ? offers.map(o => `- ${o.title} | ${o.store} | R$ ${o.price} | ${o.url}`).join('\n')
    : 'Nenhuma oferta verificável foi encontrada nas fontes disponíveis.';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/free',
        max_tokens: 280,
        temperature: 0.2,
        messages: [
          { role: 'system', content: `${ASSISTANT_SYSTEM} Use exclusivamente as ofertas fornecidas; se não houver ofertas, não invente preços.` },
          { role: 'user', content: `Pedido: ${userMessage}\n\nOfertas encontradas:\n${offerContext}` }
        ]
      }),
      signal: ctrl.signal
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('OpenRouter:', JSON.stringify(data));
      return null;
    }
    const reply = data.choices?.[0]?.message?.content?.trim();
    return reply ? { reply, offers: offers.slice(0, 8) } : null;
  } catch (error) {
    console.error('Fallback OpenRouter:', error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function groqFallback(userMessage) {
  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY.includes('COLE_')) return null;
  const search = await runSearch({ query: userMessage });
  const offers = search.offers || [];
  const offerContext = offers.length
    ? offers.map(o => `- ${o.title} | ${o.store} | R$ ${o.price} | ${o.url}`).join('\n')
    : 'Nenhuma oferta verificável foi encontrada nas fontes disponíveis.';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        max_tokens: 280,
        temperature: 0.2,
        messages: [
          { role: 'system', content: `${ASSISTANT_SYSTEM} Use exclusivamente as ofertas fornecidas; se não houver ofertas, não invente preços.` },
          { role: 'user', content: `Pedido: ${userMessage}\n\nOfertas encontradas:\n${offerContext}` }
        ]
      }),
      signal: ctrl.signal
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Groq:', JSON.stringify(data));
      return null;
    }
    const reply = data.choices?.[0]?.message?.content?.trim();
    return reply ? { reply, offers: offers.slice(0, 8) } : null;
  } catch (error) {
    console.error('Fallback Groq:', error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleAssistant(req, res) {
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.includes('COLE_')) {
    return send(res, 503, { error: 'Configure GEMINI_API_KEY no arquivo .env para usar a assistente de IA.' });
  }
  let userMessage;
  try {
    ({ message: userMessage } = await readJson(req));
  } catch {
    return send(res, 400, { error: 'Não foi possível ler a mensagem.' });
  }
  userMessage = typeof userMessage === 'string' ? userMessage.trim().slice(0, 500) : '';
  if (!userMessage) return send(res, 400, { error: 'Escreva o que você procura.' });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const contents = [{ role: 'user', parts: [{ text: userMessage }] }];
  let collectedOffers = [];
  try {
    // Uma chamada para decidir a busca e outra para redigir a resposta: evita
    // ciclos longos de function calling antes de o usuário receber o resultado.
    for (let turn = 0; turn < 2; turn++) {
      const requestBody = JSON.stringify({
        system_instruction: { parts: [{ text: ASSISTANT_SYSTEM }] },
        tools: ASSISTANT_TOOLS,
        contents,
        generationConfig: { maxOutputTokens: 320, temperature: 0.2 }
      });
      let response, data;
      // Uma nova tentativa curta só para indisponibilidade temporária (503).
      // Não repetimos 429: normalmente significa limite de quota, não congestionamento.
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        try {
          response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBody, signal: ctrl.signal });
          data = await response.json();
        } finally {
          clearTimeout(timer);
        }
        if (response.status !== 503 || attempt === 1) break;
        await new Promise(resolve => setTimeout(resolve, 900 + Math.floor(Math.random() * 400)));
      }
      if (!response.ok) {
        console.error('Gemini:', JSON.stringify(data));
        if (response.status === 429 || response.status === 503) {
          const fallback = await openRouterFallback(userMessage);
          if (fallback) return send(res, 200, { ...fallback, fallback: 'OpenRouter Free' });
          const groq = await groqFallback(userMessage);
          if (groq) return send(res, 200, { ...groq, fallback: 'Groq' });
        }
        if (response.status === 429) return send(res, 429, { error: 'O limite de uso do Gemini foi atingido. Aguarde um pouco e tente novamente.' });
        if (response.status === 503) return send(res, 503, { error: 'O Gemini está temporariamente sem capacidade. Tente novamente em alguns segundos.' });
        return send(res, 502, { error: 'A assistente de IA está indisponível no momento.' });
      }
      const parts = data.candidates?.[0]?.content?.parts || [];
      const calls = parts.filter(p => p.functionCall);
      if (!calls.length) {
        const reply = parts.filter(p => p.text).map(p => p.text).join('\n').trim();
        return send(res, 200, { reply: reply || 'Não consegui elaborar uma resposta.', offers: collectedOffers.slice(0, 8) });
      }
      contents.push(data.candidates[0].content);
      const responseParts = [];
      for (const { functionCall } of calls) {
        const args = functionCall.args || {};
        const payload = await runSearch({
          query: args.query,
          maxPrice: Number(args.maxPrice),
          onlyFreeShipping: args.freeShipping === true
        });
        if (Array.isArray(payload.offers)) collectedOffers = collectedOffers.concat(payload.offers);
        responseParts.push({ functionResponse: { name: functionCall.name, response: payload.error ? { erro: payload.error } : { ofertas: payload.offers } } });
      }
      contents.push({ role: 'user', parts: responseParts });
    }
    send(res, 200, { reply: 'A busca ficou muito longa. Tente reformular seu pedido.', offers: collectedOffers.slice(0, 8) });
  } catch (error) {
    console.error('Assistente:', error.message);
    send(res, 502, { error: 'Não foi possível falar com a assistente agora.' });
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && url.pathname === '/api/payments/preference') return createPreference(req, res);
  if (req.method === 'GET' && url.pathname === '/api/search') return searchMercadoLivre(url, res);
  if (req.method === 'POST' && url.pathname === '/api/assistant') return handleAssistant(req, res);
  if (req.method === 'GET' && url.pathname === '/login') {
    const auth = new URL('https://auth.mercadolivre.com.br/authorization');
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', process.env.MERCADO_LIVRE_CLIENT_ID);
    auth.searchParams.set('redirect_uri', process.env.MERCADO_LIVRE_REDIRECT_URI);
    res.writeHead(302, { Location: auth.toString() });
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/callback') return handleOAuthCallback(url, res);
  if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('code')) return handleOAuthCallback(url, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Método não permitido.' });
  const file = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([.][.][\\/])+/, '');
  const filePath = path.join(root, file);
  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(res, 404, 'Página não encontrada.', 'text/plain; charset=utf-8');
  res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log('CotaIA em http://localhost:3000'));
