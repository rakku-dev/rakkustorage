import fs from 'fs'
import pino from 'pino'
import { Boom } from '@hapi/boom'
import { makeWASocket } from './simple.js'
import {
  jidNormalizedUser,
  Browsers,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys'

export class Jadibot {
  constructor(options = {}) {
    this.clients = new Map()
    this.originChats = new Map() 
    this.notified = new Set()
    this.locks = new Set()
    this.reconnectAttempts = new Map()
    this.startCooldown = new Map()

    this.basePath = options.basePath || './jadibot'
    this.databaseFile = './lib/jadibot_data.json' 
    this.maxReconnect = options.maxReconnect || 5
    this.cooldownMs = options.cooldownMs || 15000
    this.maxBots = options.maxBots || 50

    this.mutedGroups = new Map()

    this.db = { mutedGroups: {} }

    if (fs.existsSync(this.databaseFile)) {
      try {
        this.db = JSON.parse(fs.readFileSync(this.databaseFile))

        if (typeof this.db.mutedGroups !== 'object' || this.db.mutedGroups === null) {
          this.db.mutedGroups = {}
        }

        for (let id in this.db.mutedGroups) {
          this.mutedGroups.set(id, this.db.mutedGroups[id])
        }
      } catch (e) {
        console.log('Gagal load jadibot_data.json', e)
      }
    }

    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true })
    }
  }

  _saveDB() {
    this.db.mutedGroups = Object.fromEntries(this.mutedGroups)
    fs.writeFileSync(this.databaseFile, JSON.stringify(this.db, null, 2))
  }

  _sessionPath(id) {
    return `${this.basePath}/${id}`
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  _cooldownActive(id) {
    return this.startCooldown.has(id) && Date.now() < this.startCooldown.get(id)
  }

  _setCooldown(id) {
    this.startCooldown.set(id, Date.now() + this.cooldownMs)
  }

  _normalizeJid(jid) {
    if (!jid) return ''
    if (jid.includes('@')) return jid
    return `${jid.replace(/[^0-9]/g, '')}@s.whatsapp.net`
  }

  _isGroupJid(jid) {
    return typeof jid === 'string' && jid.endsWith('@g.us')
  }

  _isManualGroupStart(m, options = {}) {
    if (options.autoReload) return false
    if (options.reconnect) return false
    if (options.silent) return false

    const chat = m?.chat || m?.key?.remoteJid || ''
    const isGroup = m?.isGroup === true || this._isGroupJid(chat)

    return isGroup
  }

  _safeReply(m, text) {
    try {
      if (m?.reply) return m.reply(text)
    } catch {}
  }

  async _destroySocket(from, sock, options = {}) {
    try {
      sock?.ev?.removeAllListeners?.()
    } catch {}

    try {
      sock?.ws?.close?.()
    } catch {}

    try {
      sock?.end?.()
    } catch {}

    this.clients.delete(from)
    this.originChats.delete(from)
    this.notified.delete(from)

    if (!options.keepReconnect) {
      this.reconnectAttempts.delete(from)
    }

    this.locks.delete(from)
    this.startCooldown.delete(from)

    return true
  }

  async _deleteSession(from) {
    const sessionPath = this._sessionPath(from)

    try {
      fs.rmSync(sessionPath, {
        recursive: true,
        force: true
      })

      console.log(`Session ${from} berhasil dihapus`)
    } catch (e) {
      console.log('Gagal hapus session:', e)
    }
  }

  async start(conn, from, m, options = {}) {
    from = this._normalizeJid(from)

    const chatId = m?.chat || m?.key?.remoteJid || from
    const senderJid = this._normalizeJid(m?.sender || from)
    const originChat = this._isGroupJid(chatId) ? chatId : null

    const isManualGroupStart = this._isManualGroupStart(m, options)

    if (!from) {
      return this._safeReply(m, '❌ Nomor jadibot tidak valid.')
    }

    if (this.clients.has(from)) {
      if (!options.silent && !options.reconnect && !options.autoReload) {
        return this._safeReply(m, '⚠️ Jadibot kamu sudah aktif.')
      }
      return this.clients.get(from)
    }

    if (this.locks.has(from)) {
      if (!options.silent) {
        return this._safeReply(m, '🕜 Sedang memproses sesi')
      }
      return
    }

    if (this.clients.size >= this.maxBots) {
      if (!options.silent) {
        return this._safeReply(m, '⚠️ Slot jadibot penuh.')
      }
      return
    }

    if (!options.reconnect && !options.autoReload && this._cooldownActive(from)) {
      if (!options.silent) {
        return this._safeReply(m, '⚠️ Tunggu beberapa detik sebelum mencoba lagi.')
      }
      return
    }

    this.locks.add(from)

    if (!options.reconnect && !options.autoReload) {
      this._setCooldown(from)
    }

    let sock

    try {
      const sessionPath = this._sessionPath(from)
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
      const { version } = await fetchLatestWaWebVersion()
      const logger = pino({ level: 'silent' })

      sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        browser: Browsers.windows('Chrome'),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        markOnlineOnConnect: true,
        syncFullHistory: false,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 10,
        defaultQueryTimeoutMs: 60_000
      })

      sock.isJadibot = true
      sock.jadibot = true
      sock.isSubBot = true
      sock.jadibotOwner = from
      sock.__rakkuJadibotLastPresence = 0
      sock.__rakkuJadibotReactLog = []

      const rawJadibotPresence = typeof sock.sendPresenceUpdate === 'function'
        ? sock.sendPresenceUpdate.bind(sock)
        : null

      if (rawJadibotPresence) {
        sock.sendPresenceUpdate = async (...args) => {
          const now = Date.now()

          if (now - sock.__rakkuJadibotLastPresence < 7000) return null

          sock.__rakkuJadibotLastPresence = now

          try {
            return await rawJadibotPresence(...args)
          } catch {
            return null
          }
        }
      }

      const rawJadibotSendMessage = sock.sendMessage.bind(sock)

      sock.sendMessage = async (jid, content = {}, options = {}) => {
        if (content?.react) {
          const now = Date.now()

          sock.__rakkuJadibotReactLog = (sock.__rakkuJadibotReactLog || [])
            .filter(time => now - time < 3500)

          if (sock.__rakkuJadibotReactLog.length >= 1) return null

          sock.__rakkuJadibotReactLog.push(now)
        }

        return rawJadibotSendMessage(jid, content, options)
      }

      this.clients.set(from, sock)
      if (originChat) {
        this.originChats.set(from, originChat)
      }

      if (!state.creds.registered) {
        if (!isManualGroupStart) {
          console.log(`[Jadibot] Pairing diblokir untuk ${from}. Reason: bukan manual start dari grup.`)

          await this._destroySocket(from, sock)

          if (!options.silent && !options.autoReload && !options.reconnect) {
            if (!originChat) {
              return this._safeReply(
                m,
                '⚠️ Pairing jadibot hanya bisa dilakukan dari dalam grup.\n\nMasukkan bot utama ke grup lalu ketik *.jadibot* di grup tersebut.'
              )
            }

            return this._safeReply(
              m,
              '⚠️ Pairing hanya bisa dibuat saat kamu mengetik *.jadibot* langsung dari grup.'
            )
          }

          return
        }

        await this._delay(1000)

        const phone = from.replace(/[^0-9]/g, '')

                        try {
          const code = await Promise.race([
            sock.requestPairingCode(phone, "RAKKUBOT"),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Timeout pairing code')), 30000)
            })
          ])

          const number = senderJid.split('@')[0]
          const previewUrl = 'https://rakkulabs.biz.id'
          const imgUrl = 'https://raw.githubusercontent.com/rakku-dev/rakkustorage/main/image/waiter-kezu.jpg'
          const invisible = '\u200B'.repeat(400)

          const tutorialText = `
乂  *J A D I B O T • P A I R I N G*

◦  User : +${number}

┌  ◦ *S T E P*
│  1. Buka WhatsApp
│  2. Perangkat Tertaut
│  3. Tautkan Perangkat
│  4. Masukkan Kode
└

⚠️ Hindari spam pair

✦ Ketik *.stopjadibot*
untuk menghentikan sesi
`.trim()

          // 1. Download gambar dari URL menjadi Buffer
          const axios = (await import('axios')).default
          const { prepareWAMessageMedia } = await import('@whiskeysockets/baileys')
          
          let thumbBuffer = null
          try {
            const res = await axios.get(imgUrl, { responseType: 'arraybuffer' })
            thumbBuffer = Buffer.from(res.data)
          } catch (e) {
            console.error('Gagal fetch thumb jadibot:', e)
          }

          // 2. Proses menjadi High Quality Thumbnail ala ytmp3
          let hqImage = null
          if (thumbBuffer) {
            const { imageMessage } = await prepareWAMessageMedia(
              { image: thumbBuffer },
              { upload: conn.waUploadToServer, mediaTypeOverride: 'thumbnail-link' }
            )
            hqImage = imageMessage
          }

          // 3. Kirim pesan dengan preview sempurna
          await conn.sendMessage(
            chatId,
            {
              text: `${previewUrl}${invisible}\n\n${tutorialText}`,
              mentions: [senderJid],
              linkPreview: {
                'matched-text': previewUrl,
                title: 'Waiter Jadibot',
                description: 'Rakku Waiter',
                previewType: 0,
                jpegThumbnail: thumbBuffer, // 👈 Pakai data Buffer RAM
                ...(hqImage ? { highQualityThumbnail: hqImage } : {}), // 👈 Tambahkan versi HD-nya
                linkPreviewMetadata: {
                  socialMediaPostType: 4 // 👈 Paksa jadi format kotak besar
                }
              }
            },
            { quoted: global.fkontak || m }
          )
          const codeText = `*KODE PAIRING*:\n\`${code?.match(/.{1,4}/g)?.join('-') || code}\``

          await conn.sendMessage(
            chatId,
            { text: codeText },
            { quoted: m }
          )
        } catch (err) {
          console.log('Pairing error:', err)

          await this._destroySocket(from, sock)

          return this._safeReply(m, '❌ Gagal mendapatkan kode pairing.')
        }
      }

      sock.ev.on('creds.update', saveCreds)

      sock.ev.on('connection.update', async update => {
        const { connection, lastDisconnect } = update

        if (connection === 'open') {
          this.reconnectAttempts.set(from, 0)

          await this._delay(500)

          try {
            await sock.sendPresenceUpdate('available')
          } catch {}

          try {
            console.log('Subbot aktif')
          } catch {}

          try {
            await this._delay(500)
            await sock.newsletterFollow('120363421453095412@newsletter')
            console.log('Berhasil follow channel newsletter!')
          } catch (e) {
            console.log('Gagal follow channel newsletter:', e)
          }

          // Ambil origin chat dari map
          const storedOriginChat = this.originChats.get(from)
          if (storedOriginChat && !options.autoReload && !options.reconnect) {
            await conn.sendMessage(
              storedOriginChat,
              {
                text: `
乂  *J A D I B O T • C O N N E C T E D*

◦  User : @${senderJid.split('@')[0]}
◦  Status : Online / Linked

✦ Sedang sinkronisasi database
✦ Tunggu 1-5 menit hingga aktif

_*.stopjadibot* untuk stop session_
`.trim(),
                mentions: [senderJid]
              },
              { quoted: m }
            ).catch(() => {})
          }
        }

        if (connection === 'close') {
          const reason = new Boom(lastDisconnect?.error)?.output?.statusCode

          console.log('Connection closed:', reason)

          if (
            reason === DisconnectReason.loggedOut ||
            reason === DisconnectReason.connectionReplaced ||
            reason === DisconnectReason.badSession ||
            reason === 401 ||
            reason === 403
          ) {
            console.log(`Session ${from} logout/banned, membersihkan session...`)

            const storedOriginChat = this.originChats.get(from)

            await this._destroySocket(from, sock)
            await this._deleteSession(from)

            if (storedOriginChat && !options.autoReload && !options.reconnect) {
              await conn.sendMessage(
                storedOriginChat,
                {
                  text: `
*𝗦 𝗘 𝗦 𝗦 𝗜 𝗢 𝗡   𝗢 𝗙 𝗙 𝗟 𝗜 𝗡 𝗘* ⚠️

◦ User : @${from.split('@')[0]}
◦ Status : Logout / Banned

✦ Session telah dihentikan
✦ Ketik *.jadibot* di grup untuk login ulang
`.trim(),
                  mentions: [from]
                },
                { quoted: m }
              ).catch(() => {})
            }

            return
          }


          let attempts = (this.reconnectAttempts.get(from) || 0) + 1
          this.reconnectAttempts.set(from, attempts)

          if (attempts > this.maxReconnect) {
            console.log(`Reconnect limit habis: ${from}`)

            await this._destroySocket(from, sock)
            return
          }

          const backoff = Math.min(1000 * 2 ** attempts, 30000)

          console.log(`Reconnect ${from} dalam ${backoff}ms`)

          await this._delay(backoff)

          if (this.clients.has(from)) {
            const storedOriginChat = this.originChats.get(from)

            await this._destroySocket(from, sock, { keepReconnect: true })

            await this._delay(1500)

            const reconnectMsg = {
              sender: from,
              chat: storedOriginChat || from,
              isGroup: Boolean(storedOriginChat),
              key: { remoteJid: storedOriginChat || from },
              reply: text => console.log(`[Reconnect] ${from}:`, text)
            }

            this.start(conn, from, reconnectMsg, {
              reconnect: true,
              silent: true
            }).catch(err => {
              console.log('Reconnect gagal:', err)
            })
          }
        }
      })

      const handlerModule = await import('../handler.js')
      const mainHandler = handlerModule.handler

      sock.ev.on('messages.upsert', async chatUpdate => {
        try {
          const msg = chatUpdate.messages[0]
          if (!msg?.message) return

          const chatId = msg.key.remoteJid

          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            ''

          const botJid = jidNormalizedUser(sock.user?.id)

          if (this.mutedGroups.has(chatId)) {
            const allowed = this.mutedGroups.get(chatId)

            if (text.startsWith('.tesjadibot')) {
              // bypass
            } else {
              if (allowed) {
                if (allowed !== botJid) return
              } else {
                return
              }
            }
          }

          await mainHandler.call(sock, chatUpdate)
        } catch (err) {
          console.log('Subbot error:', err)
        }
      })

      sock.ev.on('group-participants.update', async update => {
        try {
          const chatId = update.id
          const botJid = jidNormalizedUser(sock.user?.id)

          if (this.mutedGroups.has(chatId)) {
            const allowed = this.mutedGroups.get(chatId)

            if (allowed) {
              if (allowed !== botJid) return
            } else {
              return
            }
          }

          await handlerModule.participantsUpdate.call(sock, update)
        } catch (err) {
          console.log('Subbot error:', err)
        }
      })

      return sock
    } catch (err) {
      console.log('Start error:', err)

      if (sock) {
        await this._destroySocket(from, sock)
      } else {
        this.clients.delete(from)
        this.originChats.delete(from)
        this.notified.delete(from)
        this.reconnectAttempts.delete(from)
        this.locks.delete(from)
        this.startCooldown.delete(from)
      }

      if (!options.silent && !options.autoReload && !options.reconnect) {
        this._safeReply(m, '❌ Terjadi error saat memulai jadibot.')
      }
    } finally {
      this.locks.delete(from)
    }
  }

  mute(chatId, allowedBot = null) {
    if (allowedBot) {
      allowedBot = jidNormalizedUser(allowedBot)
    }

    this.mutedGroups.set(chatId, allowedBot)
    this._saveDB()
  }

  unmute(chatId) {
    this.mutedGroups.delete(chatId)
    this._saveDB()
  }

  tes(chatId, conn) {
    conn.sendMessage(chatId, { text: '✅ Jadibot aktif!' })
  }

  async stop(conn, from) {
    from = this._normalizeJid(from)

    const sock = this.clients.get(from)
    if (!sock) return

    await this._destroySocket(from, sock)

    return true
  }

  async refresh(conn, from, m) {
    from = this._normalizeJid(from)

    if (!this.clients.has(from)) {
      return m.reply('❌ Jadibot tidak ditemukan.')
    }

    await m.reply('♻️ Merefresh jadibot...')

    const sock = this.clients.get(from)

    await this._destroySocket(from, sock)

    await this._delay(1500)

    await this.start(conn, from, m, {
      reconnect: true,
      silent: true
    })
  }

  async list(conn, m) {
    if (!this.clients.size) {
      return m.reply('⚠️ Tidak ada jadibot aktif.')
    }

    let text = '⟫⟫─= LIST JADIBOT =─⟪⟪\n\n'
    let i = 1

    for (let sock of this.clients.values()) {
      if (sock.user) {
        const id = jidNormalizedUser(sock.user.id).split('@')[0]
        text += `⭘ [${i++}] @${id}\n`
      }
    }

    await m.reply(text)
  }

  async autoReload(conn) {
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true })
      return
    }

    const sessions = fs.readdirSync(this.basePath)

    for (let session of sessions) {
      try {
        const fakeJid = this._normalizeJid(session)

        const fakeMsg = {
          sender: fakeJid,
          chat: fakeJid,
          isGroup: false,
          key: { remoteJid: fakeJid },
          reply: text => console.log(`[AutoReload] ${session}:`, text)
        }

        await this.start(conn, fakeJid, fakeMsg, {
          autoReload: true,
          silent: true
        })

        await this._delay(2000)
      } catch (e) {
        console.log('Gagal restore session:', session, e)
      }
    }
  }
}
