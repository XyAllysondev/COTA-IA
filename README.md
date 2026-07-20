# CotaIA

## Pagamentos

O projeto inclui integração de **Checkout Pro do Mercado Pago**. O checkout é criado no servidor e oferece os meios de pagamento habilitados para a conta, como Pix, cartão e boleto. A credencial fica em `.env`; ela nunca é enviada ao navegador.

> Atenção: use este checkout apenas para itens que a sua empresa efetivamente vende ou intermedeia. As ofertas atuais são links de lojas de terceiros; o pagamento delas deve continuar sendo concluído na loja selecionada.

### Configuração

1. Copie `.env.example` para `.env`.
2. No painel de desenvolvedores do Mercado Pago, gere um Access Token de teste e preencha `MERCADO_PAGO_ACCESS_TOKEN`.
3. Execute `npm start` e abra `http://localhost:3000`.
4. Em produção, preencha `APP_BASE_URL` com a URL HTTPS pública e implemente um webhook para confirmar pagamentos no servidor.

A integração cria uma preferência em `POST /api/payments/preference`, conforme a [documentação oficial do Mercado Pago](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-pro/preferences/create-preference/post).

## Cotação com preços reais

A rota `GET /api/search` consulta anúncios ativos do Mercado Livre. Para uso estável, crie uma aplicação no painel de desenvolvedores do Mercado Livre e preencha `MERCADO_LIVRE_ACCESS_TOKEN` no `.env`. O token também fica somente no servidor. A página mostra apenas resultados retornados pela API — não há mais preço calculado ou estimado.
