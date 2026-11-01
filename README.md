# DJ Ressoa

Bot de música das salas de voz do Ressoa — igual aos bots de música do Discord: a música toca
no servidor e chega para todo mundo da sala como uma rádio ao vivo (`/s/<id-da-sala>.mp3`).
Avança a fila sozinho e continua tocando com o celular bloqueado ou em outro app.

Variáveis de ambiente:

| nome | o que é |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_ANON_KEY` | chave pública (anon) |
| `DJ_SECRET` | segredo do bot (o mesmo salvo em `private.dj_bot` no banco) |
| `YT_COOKIES` | opcional: cookies do YouTube (formato Netscape) se o YouTube bloquear o servidor |
| `DJ_BITRATE` | opcional, padrão `128k` |

Rotas: `GET /health`, `GET /s/<sala>.mp3` (fluxo de áudio), `GET /pos/<sala>`.

Roda com `docker build -t ressoa-dj . && docker run -p 10000:10000 --env-file .env ressoa-dj`.
