const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { readConfig } = require('./config-store');

const MAX_MEDIA_BYTES = Number(process.env.MEDIA_MAX_BYTES || 10 * 1024 * 1024);
const MEDIA_DOWNLOAD_TIMEOUT_MS = Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS || 15000);

class WhatsAppService {
  constructor(tenantId, username) {
    this.tenantId = tenantId;
    this.username = username;
    this.client = null;
    this.initializing = false;
    this.stopped = false;
    this.state = {
      status: 'disconnected',
      message: 'Belum diinisialisasi',
      qrDataUrl: null,
      account: null,
      lastError: null,
      updatedAt: new Date().toISOString()
    };
  }

  setState(changes) {
    this.state = {
      ...this.state,
      ...changes,
      updatedAt: new Date().toISOString()
    };
  }

  getStatus() {
    return { ...this.state };
  }

  requireConnected() {
    if (!this.client || this.state.status !== 'connected') {
      const error = new Error('WhatsApp belum terhubung');
      error.statusCode = 503;
      throw error;
    }
  }

  cleanBrowserLockFiles() {
    const authPath = path.resolve(process.cwd(), '.wwebjs_auth');
    const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    const cleanDir = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (lockNames.includes(entry.name)) {
            try {
              fs.unlinkSync(fullPath);
              console.log(`[whatsapp:${this.tenantId}] removed stale lock: ${fullPath}`);
            } catch {}
          } else if (entry.isDirectory()) {
            cleanDir(fullPath);
          }
        }
      } catch {}
    };
    if (fs.existsSync(authPath)) cleanDir(authPath);
  }

  async initialize() {
    if (this.stopped || this.client || this.initializing) return;

    this.initializing = true;
    this.setState({
      status: 'initializing',
      message: 'Menginisialisasi WhatsApp client',
      lastError: null
    });

    // Clean stale Chromium lock files from previous container runs
    this.cleanBrowserLockFiles();

    const puppeteer = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run'
      ]
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteer.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.tenantId,
        dataPath: '.wwebjs_auth'
      }),
      puppeteer,
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/nicholaschun/nicholaschun-web-wak/main/nicholaschun-web-wak',
      }
    });

    this.registerEvents();

    try {
      await this.client.initialize();
    } catch (error) {
      const isBrowserRunning = error.message?.includes('already running');
      this.setState({
        status: 'error',
        message: isBrowserRunning
          ? 'Browser sebelumnya belum berhenti, membersihkan dan mencoba ulang...'
          : 'Gagal menginisialisasi WhatsApp',
        lastError: error.message
      });

      // Force kill any orphaned browser processes
      if (isBrowserRunning) {
        try {
          require('node:child_process').execSync(
            'pkill -f chromium 2>/dev/null || pkill -f chrome 2>/dev/null || true',
            { stdio: 'ignore', timeout: 5000 }
          );
        } catch {}
        this.cleanBrowserLockFiles();
      }

      this.client = null;
      console.error(`[whatsapp:${this.tenantId}] initialize error:`, error.message);
      if (!this.stopped) {
        const retryDelay = isBrowserRunning ? 5000 : 15000;
        console.log(`[whatsapp:${this.tenantId}] retrying in ${retryDelay / 1000}s...`);
        setTimeout(() => this.initialize(), retryDelay);
      }
    } finally {
      this.initializing = false;
    }
  }

  registerEvents() {
    this.client.on('qr', async (qr) => {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, {
          width: 320,
          margin: 2,
          errorCorrectionLevel: 'M'
        });
        this.setState({
          status: 'qr',
          message: 'Pindai QR code dengan aplikasi WhatsApp',
          qrDataUrl,
          account: null,
          lastError: null
        });
      } catch (error) {
        this.setState({ status: 'error', message: 'Gagal membuat QR code', lastError: error.message });
      }
    });

    this.client.on('authenticated', () => {
      this.setState({
        status: 'authenticated',
        message: 'Autentikasi berhasil, menyiapkan sesi',
        qrDataUrl: null,
        lastError: null
      });
    });

    this.client.on('ready', () => {
      const info = this.client.info;
      this.setState({
        status: 'connected',
        message: 'WhatsApp terhubung',
        qrDataUrl: null,
        account: info
          ? {
              wid: info.wid?._serialized || null,
              pushname: info.pushname || null,
              platform: info.platform || null
            }
          : null,
        lastError: null
      });
    });

    this.client.on('auth_failure', (message) => {
      this.setState({
        status: 'auth_failure',
        message: 'Autentikasi WhatsApp gagal',
        qrDataUrl: null,
        lastError: message
      });
    });

    this.client.on('disconnected', (reason) => {
      this.setState({
        status: 'disconnected',
        message: `WhatsApp terputus: ${reason}`,
        qrDataUrl: null,
        account: null
      });
      this.client = null;
      if (!this.stopped) setTimeout(() => this.initialize(), 5000);
    });

    this.client.on('change_state', (state) => {
      if (this.state.status !== 'connected') {
        this.setState({ message: `Status WhatsApp: ${state}` });
      }
    });

    this.client.on('message', (message) => {
      this.forwardIncomingMessage(message).catch((error) => {
        console.error(`[webhook:${this.tenantId}] delivery error:`, error.message);
      });
    });
  }

  async forwardIncomingMessage(message) {
    const config = readConfig(this.tenantId, this.username);
    if (!config.webhook?.enabled || !config.webhook?.url) return;

    // whatsapp-web.js getChat/getContact sometimes hang infinitely in production. Use a 3s timeout.
    const withTimeout = (promise, ms) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);

    const chat = await withTimeout(message.getChat(), 3000).catch(() => null);
    const contact = await withTimeout(message.getContact(), 3000).catch(() => null);

    const payload = {
      event: 'message.received',
      receivedAt: new Date().toISOString(),
      data: {
        id: message.id?._serialized || null,
        from: message.from,
        to: message.to,
        author: message.author || null,
        body: message.body,
        type: message.type,
        timestamp: message.timestamp,
        hasMedia: message.hasMedia,
        isForwarded: message.isForwarded,
        fromMe: message.fromMe,
        chat: chat
          ? {
              id: chat.id?._serialized || null,
              name: chat.name || null,
              isGroup: Boolean(chat.isGroup)
            }
          : null,
        contact: contact
          ? {
              id: contact.id?._serialized || null,
              name: contact.name || contact.pushname || null,
              number: contact.number || null
            }
          : null
      }
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(config.webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'wa-web-api/1.0'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Webhook merespons HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  normalizeRecipient(recipient) {
    const value = String(recipient || '').trim();
    if (!value) throw new Error('Field "to" wajib diisi');
    if (value.endsWith('@c.us') || value.endsWith('@g.us')) return value;

    const digits = value.replace(/\D/g, '');
    if (!digits) throw new Error('Nomor penerima tidak valid');
    return `${digits}@c.us`;
  }

  createHttpError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  isPrivateIp(address) {
    if (net.isIPv4(address)) {
      const parts = address.split('.').map(Number);
      return parts[0] === 10
        || parts[0] === 127
        || parts[0] === 0
        || (parts[0] === 169 && parts[1] === 254)
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168)
        || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
        || parts[0] >= 224;
    }

    if (net.isIPv6(address)) {
      const normalized = address.toLowerCase();
      if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice(7);
        if (net.isIPv4(mapped)) return this.isPrivateIp(mapped);
        const groups = mapped.split(':');
        if (groups.length === 2) {
          const high = Number.parseInt(groups[0], 16);
          const low = Number.parseInt(groups[1], 16);
          if (Number.isInteger(high) && Number.isInteger(low)) {
            return this.isPrivateIp([
              high >> 8,
              high & 255,
              low >> 8,
              low & 255
            ].join('.'));
          }
        }
        return true;
      }
      return normalized === '::1'
        || normalized === '::'
        || normalized.startsWith('fc')
        || normalized.startsWith('fd')
        || normalized.startsWith('ff')
        || normalized.startsWith('fe8')
        || normalized.startsWith('fe9')
        || normalized.startsWith('fea')
        || normalized.startsWith('feb');
    }

    return true;
  }

  async validateMediaUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw this.createHttpError('URL media tidak valid', 400);
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw this.createHttpError('URL media harus menggunakan HTTP atau HTTPS', 400);
    }

    if (url.username || url.password) {
      throw this.createHttpError('URL media tidak boleh berisi username atau password', 400);
    }

    if (process.env.ALLOW_PRIVATE_MEDIA_URLS !== 'true') {
      if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) {
        throw this.createHttpError('URL media lokal tidak diizinkan', 400);
      }

      let addresses;
      try {
        addresses = await dns.lookup(url.hostname, { all: true });
      } catch {
        throw this.createHttpError('Host URL media tidak dapat ditemukan', 400);
      }

      if (!addresses.length || addresses.some(({ address }) => this.isPrivateIp(address))) {
        throw this.createHttpError('URL media menuju jaringan privat tidak diizinkan', 400);
      }
    }

    return url;
  }

  sanitizeFilename(value) {
    const filename = path.basename(String(value || 'file')).replace(/[\u0000-\u001f\u007f]/g, '');
    return filename.slice(0, 255) || 'file';
  }

  decodeFilename(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  async downloadMedia(urlValue) {
    let currentUrl = await this.validateMediaUrl(urlValue);

    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);

      try {
        const response = await fetch(currentUrl, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: '*/*', 'user-agent': 'wa-web-api/1.0' }
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || redirectCount === 3) {
            throw this.createHttpError('Redirect URL media terlalu banyak atau tidak valid', 400);
          }
          currentUrl = await this.validateMediaUrl(new URL(location, currentUrl).toString());
          continue;
        }

        if (!response.ok) {
          throw this.createHttpError(`Gagal mengunduh media: HTTP ${response.status}`, 400);
        }
        if (!response.body) {
          throw this.createHttpError('Respons URL media tidak memiliki isi file', 400);
        }

        const declaredSize = Number(response.headers.get('content-length') || 0);
        if (declaredSize > MAX_MEDIA_BYTES) {
          throw this.createHttpError(`Ukuran media melebihi batas ${MAX_MEDIA_BYTES} byte`, 413);
        }

        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_MEDIA_BYTES) {
            throw this.createHttpError(`Ukuran media melebihi batas ${MAX_MEDIA_BYTES} byte`, 413);
          }
          chunks.push(chunk);
        }

        const mimetype = (response.headers.get('content-type') || 'application/octet-stream')
          .split(';')[0]
          .trim();
        const disposition = response.headers.get('content-disposition') || '';
        const dispositionFilename = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1];
        const urlFilename = this.decodeFilename(currentUrl.pathname.split('/').pop() || 'file');

        return {
          data: Buffer.concat(chunks).toString('base64'),
          mimetype,
          filename: this.sanitizeFilename(dispositionFilename || urlFilename),
          filesize: size
        };
      } catch (error) {
        if (error.name === 'AbortError') {
          throw this.createHttpError('Download media melewati batas waktu', 408);
        }
        if (!error.statusCode) {
          throw this.createHttpError(`Gagal mengunduh media: ${error.message}`, 400);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw this.createHttpError('Gagal mengunduh media', 400);
  }

  parseBase64Media(media) {
    let data = String(media.data || '').trim();
    let mimetype = String(media.mimetype || '').trim();
    const dataUri = data.match(/^data:([^;,]+);base64,(.+)$/s);

    if (dataUri) {
      mimetype = mimetype || dataUri[1];
      data = dataUri[2];
    }

    if (!data || !mimetype) {
      throw this.createHttpError('Media Base64 memerlukan field "data" dan "mimetype"', 400);
    }
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimetype)) {
      throw this.createHttpError('MIME type media tidak valid', 400);
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data.replace(/\s/g, ''))) {
      throw this.createHttpError('Data media bukan Base64 yang valid', 400);
    }

    data = data.replace(/\s/g, '');
    if (data.length % 4 === 1) {
      throw this.createHttpError('Data media bukan Base64 yang valid', 400);
    }
    if (data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 4) {
      throw this.createHttpError(`Ukuran media melebihi batas ${MAX_MEDIA_BYTES} byte`, 413);
    }
    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) {
      throw this.createHttpError(
        buffer.length > MAX_MEDIA_BYTES
          ? `Ukuran media melebihi batas ${MAX_MEDIA_BYTES} byte`
          : 'Data media kosong',
        buffer.length > MAX_MEDIA_BYTES ? 413 : 400
      );
    }

    return {
      data: buffer.toString('base64'),
      mimetype,
      filename: this.sanitizeFilename(media.filename),
      filesize: buffer.length
    };
  }

  async buildMessageMedia(media) {
    if (!media || typeof media !== 'object' || Array.isArray(media)) {
      throw this.createHttpError('Field "media" harus berupa object', 400);
    }
    if (media.url && media.data) {
      throw this.createHttpError('Gunakan salah satu sumber media: "url" atau "data"', 400);
    }
    if (media.mimetype && !/^[\w.+-]+\/[\w.+-]+$/.test(media.mimetype)) {
      throw this.createHttpError('MIME type media tidak valid', 400);
    }

    const source = media.url
      ? await this.downloadMedia(media.url)
      : this.parseBase64Media(media);

    return new MessageMedia(
      media.mimetype || source.mimetype,
      source.data,
      this.sanitizeFilename(media.filename || source.filename),
      source.filesize
    );
  }

  async sendMessage({ to, message, media }) {
    this.requireConnected();

    if (!media && (typeof message !== 'string' || !message.trim())) {
      throw this.createHttpError('Field "message" wajib berupa teks', 400);
    }
    if (message !== undefined && typeof message !== 'string') {
      throw this.createHttpError('Field "message" harus berupa teks', 400);
    }

    const chatId = this.normalizeRecipient(to);
    const result = media
      ? await this.client.sendMessage(chatId, await this.buildMessageMedia(media), {
          caption: message?.trim() || undefined,
          sendMediaAsDocument: Boolean(media.asDocument),
          sendAudioAsVoice: Boolean(media.asVoice),
          sendVideoAsGif: Boolean(media.asGif),
          sendMediaAsSticker: Boolean(media.asSticker),
          isViewOnce: Boolean(media.viewOnce)
        })
      : await this.client.sendMessage(chatId, message);

    return {
      id: result?.id?._serialized || null,
      to: chatId,
      body: result?.body || message,
      timestamp: result?.timestamp || null,
      hasMedia: Boolean(media),
      media: media && result
        ? {
            filename: result._data?.filename || media.filename || null,
            mimetype: result._data?.mimetype || media.mimetype || null
          }
        : null
    };
  }

  async listGroups() {
    this.requireConnected();

    const chats = await this.client.getChats();
    return chats
      .filter((chat) => chat.isGroup)
      .map((chat) => ({
        id: chat.id?._serialized || null,
        name: chat.name || null,
        unreadCount: chat.unreadCount || 0,
        archived: Boolean(chat.archived),
        participantCount: Array.isArray(chat.participants) ? chat.participants.length : null
      }));
  }

  normalizeInviteCode(invite) {
    const value = String(invite || '').trim();
    if (!value) {
      const error = new Error('Field "inviteLink" atau "inviteCode" wajib diisi');
      error.statusCode = 400;
      throw error;
    }

    const match = value.match(/(?:https?:\/\/)?(?:www\.)?chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
    const code = match ? match[1] : value;

    if (!/^[A-Za-z0-9_-]+$/.test(code)) {
      const error = new Error('Link atau kode undangan grup tidak valid');
      error.statusCode = 400;
      throw error;
    }

    return code;
  }

  async joinGroup({ inviteLink, inviteCode }) {
    this.requireConnected();

    const code = this.normalizeInviteCode(inviteLink || inviteCode);
    const groupId = await this.client.acceptInvite(code);

    return {
      id: groupId?._serialized || groupId || null,
      joined: true
    };
  }

  async logout() {
    if (!this.client) return;
    await this.client.logout();
    await this.client.destroy().catch(() => {});
    this.client = null;
    this.setState({
      status: 'disconnected',
      message: 'Sesi WhatsApp telah dikeluarkan',
      qrDataUrl: null,
      account: null,
      lastError: null
    });
    setTimeout(() => this.initialize(), 1000);
  }

  async stop() {
    this.stopped = true;
    if (this.client) await this.client.destroy().catch(() => {});
    this.client = null;
  }
}

class WhatsAppManager {
  constructor() {
    this.services = new Map();
    const configuredLimit = Number(process.env.MAX_ACTIVE_TENANTS || 10);
    this.maxActiveTenants = Number.isInteger(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : 10;
  }

  get(tenantId, username) {
    let service = this.services.get(tenantId);
    if (!service) {
      if (this.services.size >= this.maxActiveTenants) {
        const error = new Error(
          `Batas ${this.maxActiveTenants} tenant WhatsApp aktif telah tercapai`
        );
        error.statusCode = 503;
        throw error;
      }
      service = new WhatsAppService(tenantId, username);
      this.services.set(tenantId, service);
      service.initialize();
    }
    return service;
  }

  async destroy(tenantId) {
    const service = this.services.get(tenantId);
    if (!service) return;
    this.services.delete(tenantId);
    await service.stop();
  }

  async destroyAll() {
    await Promise.all([...this.services.keys()].map((tenantId) => this.destroy(tenantId)));
  }

  activeTenants() {
    return [...this.services.values()].map(({ tenantId, username }) => ({
      tenantId,
      username
    }));
  }
}

module.exports = new WhatsAppManager();
