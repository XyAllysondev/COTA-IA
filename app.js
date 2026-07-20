const results = document.querySelector('#results');
const offers = document.querySelector('#offers');
const template = document.querySelector('#offer-template');
const summary = document.querySelector('#summary');
const aiReply = document.querySelector('#ai-reply');

function brl(value) { return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function renderOffers(list) {
  offers.innerHTML = '';
  (list || []).forEach((offer, index) => {
    const card = template.content.cloneNode(true);
    card.querySelector('.store-logo').textContent = (offer.store || '?').slice(0, 2).toUpperCase();
    card.querySelector('.store').textContent = `${offer.store} · ${index === 0 ? 'MENOR PREÇO' : (offer.condition || 'Novo').toUpperCase()}`;
    card.querySelector('h3').textContent = offer.title;
    card.querySelector('.delivery').textContent = offer.freeShipping ? 'Frete grátis' : 'Frete e prazo informados na loja';
    card.querySelector('strong').textContent = brl(offer.price);
    const link = card.querySelector('a');
    link.href = offer.url;
    link.textContent = 'Ver oferta ↗';
    offers.append(card);
  });
}
const aiForm = document.querySelector('#ai-form');
aiForm.addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.querySelector('#ai-input');
  const message = input.value.trim();
  if (!message) return;
  const button = aiForm.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Pensando...';
  offers.innerHTML = '';
  results.classList.remove('hidden');
  aiReply.classList.remove('hidden');
  aiReply.textContent = 'A IA está analisando seu pedido e buscando preços...';
  document.querySelector('#results-title').textContent = 'Resposta da IA';
  summary.textContent = '';
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const response = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha ao falar com a IA.');
    aiReply.textContent = data.reply;
    summary.textContent = data.offers.length ? `${data.offers.length} ofertas consideradas pela IA:` : '';
    renderOffers(data.offers);
  } catch (error) {
    aiReply.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Perguntar ✦';
  }
});

document.querySelector('#reset').addEventListener('click', () => {
  results.classList.add('hidden');
  aiReply.classList.add('hidden');
  document.querySelector('#ai-input').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
