// DJ Ressoa — o "bot de música" das salas de voz.
//
// Igual aos bots do Discord: a música toca no servidor, não no aparelho de cada pessoa.
// Para cada sala de voz com gente ouvindo, o bot:
//   1. lê o que deve tocar (music_state no Supabase, mudado pelos comandos /tocar, /pular...),
//   2. baixa o áudio (yt-dlp) e decodifica (ffmpeg),
//   3. transmite um único fluxo MP3 ao vivo, igual a uma rádio, em /s/<id-da-sala>.mp3,
//   4. passa para a próxima música da fila sozinho quando a atual acaba.
// Todo mundo ouve a mesma coisa no mesmo instante, e o fluxo nunca para (silêncio quando
// pausado), então o celular continua tocando com a tela bloqueada ou em outro app.
//
// Sem dependências do npm: só Node 20+, ffmpeg e yt-dlp.

import http from 'node:http'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const PORT = Number(process.env.PORT || 10000)
const SUPA = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const KEY = process.env.SUPABASE_ANON_KEY || ''
const SECRET = process.env.DJ_SECRET || ''
const BITRATE = process.env.DJ_BITRATE || '128k'
const YTDLP = process.env.YTDLP || 'yt-dlp'
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
// para testes locais: comando que gera o áudio no lugar do yt-dlp ("{id}" e "{pos}" são trocados)
const TEST_SOURCE = process.env.DJ_TEST_SOURCE || ''

let COOKIES = null
if (process.env.YT_COOKIES) {
  // cookies do YouTube (formato Netscape), se o YouTube começar a bloquear o servidor
  COOKIES = '/tmp/yt-cookies.txt'
  writeFileSync(COOKIES, process.env.YT_COOKIES.replace(/\\n/g, '\n'))
}

const RATE = 48000
const BPS = RATE * 2 * 2 // PCM 16 bits estéreo: bytes por segundo
const FRAME_MS = 20
const FRAME = (BPS * FRAME_MS) / 1000 // 3840 bytes
const SILENCE = Buffer.alloc(FRAME)
const MAX_AHEAD = BPS * 12 // até 12 s decodificados à frente
const LOW_AHEAD = BPS * 6
const IDLE_MS = 90_000 // sala sem ninguém ouvindo por 90 s: o bot sai
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

async function rpc(fn, args) {
  const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: SECRET, ...args }),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

function run(cmd, args, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => {
      clearTimeout(t)
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').slice(-2).join(' ') || `saiu com ${code}`))
    })
  })
}

// Descobre o endereço do áudio. YouTube primeiro; se o YouTube bloquear o servidor,
// procura a mesma música no SoundCloud pelo título.
async function resolveAudio(videoId, title) {
  const base = ['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '--js-runtimes', 'node', '--print', 'duration', '--print', 'urls']
  if (COOKIES) base.push('--cookies', COOKIES)
  const tries = [
    { source: 'youtube', args: [...base, `https://www.youtube.com/watch?v=${videoId}`] },
    { source: 'youtube', args: [...base, '--extractor-args', 'youtube:player_client=tv,web_safari,mweb', `https://www.youtube.com/watch?v=${videoId}`] },
  ]
  if (title) tries.push({ source: 'soundcloud', args: [...base, `scsearch1:${title.replace(/\(.*?\)|\[.*?\]|official|video|clipe|lyrics?|letra/gi, ' ').trim()}`] })
  let last
  for (const t of tries) {
    try {
      const lines = (await run(YTDLP, t.args)).trim().split('\n').filter(Boolean)
      const url = lines.find((l) => /^https?:\/\//.test(l))
      const dur = parseFloat(lines.find((l) => /^\d+(\.\d+)?$/.test(l)))
      if (url) return { url, duration: isFinite(dur) ? dur : null, source: t.source }
    } catch (e) {
      last = e
      log('yt-dlp falhou', t.source, String(e.message).slice(0, 200))
    }
  }
  throw last || new Error('sem áudio')
}

class Room {
  constructor(id) {
    this.id = id
    this.listeners = new Set()
    this.lastListener = Date.now()
    this.state = null
    this.cur = null // { current_id, decoder, chunks, ahead, startPos, played, ended, synced, failed }
    this.recent = [] // últimos pedaços de MP3 (para quem entra começar a ouvir na hora)
    this.recentBytes = 0
    this.loading = false
    this.startEncoder()
    this.t0 = Date.now()
    this.sent = 0
    this.tick = setInterval(() => this.pump(), FRAME_MS)
    log('sala aberta', id)
  }

  startEncoder() {
    const enc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '2', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', BITRATE, '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'inherit'] })
    enc.stdin.on('error', () => {})
    enc.stdout.on('data', (buf) => {
      this.recent.push(buf)
      this.recentBytes += buf.length
      while (this.recentBytes > 32 * 1024 && this.recent.length > 1) this.recentBytes -= this.recent.shift().length
      for (const res of this.listeners) {
        if (res.writableLength > 512 * 1024) {
          res.destroy() // ouvinte travado: derruba, o app reconecta
          continue
        }
        res.write(buf)
      }
    })
    enc.on('close', () => {
      if (!this.closed) {
        log('codificador caiu, reiniciando', this.id)
        this.startEncoder()
      }
    })
    this.enc = enc
  }

  // posição real do que está saindo agora (segundos)
  pos() {
    const c = this.cur
    return c ? c.startPos + c.played / BPS : 0
  }

  // relógio de tempo real: entrega 20 ms de áudio por vez para o codificador
  pump() {
    const due = Math.floor((Date.now() - this.t0) / FRAME_MS)
    let n = Math.min(due - this.sent, 25)
    if (due - this.sent > 100) this.sent = due - 1 // ficou muito atrás (servidor travou): pula
    for (; n > 0; n--) {
      this.sent++
      this.enc.stdin.write(this.frame())
    }
  }

  frame() {
    const c = this.cur
    if (!c || !this.state?.playing || c.current_id !== this.state.current_id) return SILENCE
    if (c.ahead < FRAME) {
      if (c.ended && !c.finished && !c.failed) {
        c.finished = Date.now()
        this.trackEnded(c)
      }
      return SILENCE
    }
    const out = Buffer.allocUnsafe(FRAME)
    let off = 0
    while (off < FRAME) {
      const head = c.chunks[0]
      const take = Math.min(head.length, FRAME - off)
      head.copy(out, off, 0, take)
      off += take
      if (take === head.length) c.chunks.shift()
      else c.chunks[0] = head.subarray(take)
    }
    c.ahead -= FRAME
    c.played += FRAME
    if (!c.synced) {
      c.synced = true
      this.fails = 0
      broken = false
      // avisa o banco onde a música está de verdade (para a barra de progresso de todo mundo)
      rpc('dj_bot_sync', { p_voice: this.id, p_current: c.current_id, p_position: c.startPos, p_duration: c.duration }).catch((e) => log('sync', e.message))
    }
    if (c.paused && c.ahead < LOW_AHEAD) {
      c.paused = false
      c.decoder?.stdout.resume()
    }
    return out
  }

  async trackEnded(c) {
    log('acabou', this.id, c.title)
    try {
      await rpc('dj_bot_next', { p_voice: this.id, p_from: c.current_id })
    } catch (e) {
      log('next', e.message)
    }
  }

  stopDecoder() {
    const c = this.cur
    if (c?.decoder) {
      c.dead = true
      try {
        c.decoder.kill('SIGKILL')
      } catch {
        /* ok */
      }
    }
    this.cur = null
  }

  expected(st) {
    if (!st) return 0
    const p = Number(st.position) || 0
    return st.playing ? p + Math.max(0, (Date.now() - new Date(st.updated_at).getTime()) / 1000) : p
  }

  async startTrack(st, at) {
    this.stopDecoder()
    const c = { current_id: st.current_id, title: st.title, chunks: [], ahead: 0, played: 0, startPos: at, ended: false, synced: false, duration: null }
    this.cur = c
    this.loading = true
    try {
      let input
      if (TEST_SOURCE) {
        input = { url: null, duration: null, source: 'teste' }
      } else {
        input = await resolveAudio(st.video_id, st.title)
      }
      if (c !== this.cur) return
      c.duration = input.duration
      if (input.duration && at >= input.duration - 1) {
        // já passou do fim enquanto ninguém ouvia
        c.ended = true
        return
      }
      log('tocando', this.id, input.source, st.title, `@${at.toFixed(1)}s`)
      const args = TEST_SOURCE
        ? TEST_SOURCE.replace('{id}', st.video_id).replace('{pos}', at.toFixed(2)).split(' ')
        : ['-hide_banner', '-loglevel', 'error', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-ss', at.toFixed(2), '-i', input.url, '-vn', '-f', 's16le', '-ar', String(RATE), '-ac', '2', 'pipe:1']
      const dec = spawn(TEST_SOURCE ? args[0] : FFMPEG, TEST_SOURCE ? args.slice(1) : args, { stdio: ['ignore', 'pipe', 'pipe'] })
      c.decoder = dec
      let err = ''
      dec.stderr.on('data', (d) => (err = (err + d).slice(-400)))
      dec.stdout.on('data', (buf) => {
        if (c.dead) return
        c.chunks.push(buf)
        c.ahead += buf.length
        if (c.ahead > MAX_AHEAD && !c.paused) {
          c.paused = true
          dec.stdout.pause()
        }
      })
      dec.on('close', (code) => {
        if (c.dead) return
        if (code && !c.played && !c.ahead) log('decodificador falhou', err.trim())
        c.ended = true
      })
    } catch (e) {
      log('não deu para tocar', st.title, e.message)
      if (c !== this.cur) return
      this.fails = (this.fails || 0) + 1
      if (this.fails >= 3) {
        // 3 músicas seguidas sem tocar: o problema é o servidor (ex.: YouTube bloqueou), não a música.
        // Para de pular a fila e avisa o app, que toca pelo YouTube no aparelho enquanto isso.
        c.failed = true
        broken = true
        this.broken = true
      } else c.ended = true // pula para a próxima
    } finally {
      if (c === this.cur) this.loading = false
    }
  }

  // aplica o estado que veio do banco
  apply(st) {
    this.state = st && st.video_id ? st : null
    const s = this.state
    if (!s) {
      if (this.cur) this.stopDecoder()
      return
    }
    const c = this.cur
    if (c?.failed && c.current_id === s.current_id) return
    if (c?.finished && c.current_id === s.current_id && Date.now() - c.finished > 8000) {
      c.finished = Date.now() // o banco não avançou: tenta de novo
      this.trackEnded(c)
      return
    }
    if (!c || c.current_id !== s.current_id) {
      this.broken = false
      const at = this.expected(s)
      this.startTrack(s, at < 4 ? 0 : at) // música que acabou de começar: toca do início
      return
    }
    // mesma música: se alguém pausou/voltou em outro ponto, ajusta
    if (s.playing && c.synced && !c.ended) {
      const diff = this.expected(s) - this.pos()
      if (Math.abs(diff) > 5) this.startTrack(s, this.expected(s))
    }
  }

  add(res) {
    this.listeners.add(res)
    this.lastListener = Date.now()
    for (const b of this.recent) res.write(b)
  }

  remove(res) {
    this.listeners.delete(res)
    this.lastListener = Date.now()
  }

  close() {
    this.closed = true
    clearInterval(this.tick)
    this.stopDecoder()
    try {
      this.enc.stdin.end()
      this.enc.kill('SIGKILL')
    } catch {
      /* ok */
    }
    for (const r of this.listeners) r.end()
    log('sala fechada', this.id)
  }
}

const rooms = new Map()
let broken = false // o servidor não está conseguindo baixar músicas

function room(id) {
  let r = rooms.get(id)
  if (!r) {
    r = new Room(id)
    rooms.set(id, r)
    poll() // já busca o estado
  }
  return r
}

let polling = false
async function poll() {
  if (polling || !rooms.size) return
  polling = true
  try {
    const now = Date.now()
    for (const [id, r] of rooms) if (!r.listeners.size && now - r.lastListener > IDLE_MS) (r.close(), rooms.delete(id))
    const ids = [...rooms.keys()]
    if (ids.length) {
      const rows = (await rpc('dj_bot_state', { p_channels: ids })) || []
      const by = new Map(rows.map((x) => [x.channel_id, x]))
      for (const id of ids) rooms.get(id)?.apply(by.get(id) || null)
    }
  } catch (e) {
    log('poll', e.message)
  } finally {
    polling = false
  }
}
setInterval(poll, 1000)

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*' }

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()
    if (url.pathname === '/' || url.pathname === '/health') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify({ ok: !!(SUPA && KEY && SECRET), broken, salas: rooms.size, ouvintes: [...rooms.values()].reduce((a, r) => a + r.listeners.size, 0) }))
    }
    const m = /^\/s\/([0-9a-f-]{36})(?:\.mp3)?$/i.exec(url.pathname)
    if (m && UUID.test(m[1])) {
      const r = room(m[1].toLowerCase())
      res.writeHead(200, {
        ...CORS,
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
        'icy-name': 'DJ Ressoa',
      })
      if (req.method === 'HEAD') return res.end()
      res.socket?.setNoDelay(true)
      r.add(res)
      const bye = () => r.remove(res)
      req.on('close', bye)
      res.on('error', bye)
      return
    }
    const p = /^\/pos\/([0-9a-f-]{36})$/i.exec(url.pathname)
    if (p) {
      const r = rooms.get(p[1].toLowerCase())
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify(r ? { current_id: r.cur?.current_id || null, pos: r.pos(), playing: !!r.state?.playing, loading: r.loading, broken: !!r.broken } : null))
    }
    res.writeHead(404, CORS).end('não encontrado')
  })
  .listen(PORT, () => log(`DJ Ressoa ouvindo na porta ${PORT}${SECRET ? '' : ' (SEM DJ_SECRET!)'}`))

process.on('SIGTERM', () => {
  rooms.forEach((r) => r.close())
  process.exit(0)
})
