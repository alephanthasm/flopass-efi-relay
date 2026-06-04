# FLOPASS Efí PIX Relay

Servico relay para integracao segura entre Efí (Gerencianet) PIX e o app FLOPASS.

## Deploy no Render

1. Crie um novo **Web Service** no Render
2. Conecte este repositorio
3. Configure:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Adicione as Environment Variables abaixo

## Variaveis de Ambiente

| Variavel | Descricao | Exemplo |
|----------|-----------|---------|
| `EFIPAY_CLIENT_ID` | Client ID da Efí | `Client_Id_xxx` |
| `EFIPAY_CLIENT_SECRET` | Client Secret da Efí | `Client_Secret_xxx` |
| `EFIPAY_CERTIFICATE_BASE64` | Certificado .p12 em base64 | `MII...==` |
| `EFIPAY_ENV` | Ambiente | `sandbox` ou `production` |
| `RELAY_SECRET` | Segredo para autenticar Lovable | `sua-string-secreta-32chars` |
| `PIX_KEY` | Sua chave PIX na Efí | `email@dominio.com` |
| `WEBHOOK_FORWARD_URL` | URL do webhook no Lovable | `https://seu-app.lovable.app/api/public/payments/efipay-webhook` |

## Como gerar o certificado base64

```bash
base64 -i seu-certificado.p12 | tr -d '\n'
```

Cole o resultado na variavel `EFIPAY_CERTIFICATE_BASE64`.

## Endpoints

| Metodo | Rota | Descricao |
|--------|------|-----------|
| POST | `/pix/charge` | Cria cobranca PIX + QR Code |
| GET | `/pix/charge/:txid` | Consulta status da cobranca |
| POST | `/pix/webhook-config` | Configura webhook na Efí |
| POST | `/pix/webhook` | Recebe e encaminha webhooks |
| GET | `/health` | Health check |

Todas as rotas (exceto `/pix/webhook` e `/health`) exigem o header `X-Relay-Secret`.
