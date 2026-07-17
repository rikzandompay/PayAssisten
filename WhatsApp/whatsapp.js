const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { readConfig } = require('./config-store');
const { writeConfig } = require('./config-store');

class WhatsAppService {
    constructor(tenantId) {
        this.tenantId = tenantId;
        this.client = null;
        this.qrCode = null;
        this.status = 'DISCONNECTED';
        this.connectedAt = null;
        this.initPromise = null;
    }

    async initialize() {
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            try {
                const config = await readConfig(this.tenantId);
                const webhookUrl = config?.webhookUrl || null;

                const puppeteer = {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--no-first-run',
                        '--no-zygote',
                        '--single-process'
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
                        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
                    }
                });

                this.registerEvents();

                try {
                    await this.client.initialize();
                } catch (error) {
                    console.error(`[Tenant ${this.tenantId}] Failed to initialize client:`, error);
                    this.status = 'DISCONNECTED';
                    this.initPromise = null;
                    throw error;
                }
            } catch (error) {
                this.initPromise = null;
                throw error;
            }
        })();

        return this.initPromise;
    }

    registerEvents() {
        this.client.on('qr', async (qr) => {
            this.qrCode = qr;
            this.status = 'SCAN_QR';
        });

        this.client.on('ready', () => {
            console.log(`[Tenant ${this.tenantId}] Client is READY!`);
            this.qrCode = null;
            this.status = 'CONNECTED';
            this.connectedAt = new Date().toISOString();
        });

        this.client.on('authenticated', () => {
            console.log(`[Tenant ${this.tenantId}] AUTHENTICATED successfully!`);
            this.status = 'AUTHENTICATING';
        });

        this.client.on('auth_failure', (msg) => {
            console.error(`[Tenant ${this.tenantId}] Auth failure:`, msg);
            this.status = 'DISCONNECTED';
        });

        this.client.on('disconnected', (reason) => {
            console.log(`[Tenant ${this.tenantId}] Client was logged out:`, reason);
            this.qrCode = null;
            this.status = 'DISCONNECTED';
            this.connectedAt = null;
        });

        this.client.on('message', async (msg) => {
            try {
                // Baca webhook URL dari env var (priority) atau dari config store
                let webhookUrl = process.env.WEBHOOK_URL || null;
                if (!webhookUrl) {
                    const config = await readConfig(this.tenantId);
                    webhookUrl = config?.webhookUrl || null;
                }
                if (!webhookUrl) {
                    console.warn(`[Tenant ${this.tenantId}] No webhook URL configured. Set WEBHOOK_URL env var.`);
                    return;
                }

                const payload = {
                    event: 'message',
                    data: {
                        id: msg.id._serialized,
                        body: msg.body,
                        from: msg.from,
                        to: msg.to,
                        fromMe: msg.fromMe,
                        timestamp: msg.timestamp,
                        hasMedia: msg.hasMedia,
                        type: msg.type
                    }
                };

                if (msg.hasMedia) {
                    try {
                        const media = await msg.downloadMedia();
                        if (media) {
                            payload.data.media = {
                                mimetype: media.mimetype,
                                data: media.data,
                                filename: media.filename || null
                            };
                        }
                    } catch (err) {
                        console.error(`[Tenant ${this.tenantId}] Error downloading media:`, err);
                    }
                }

                fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch((err) => {
                    console.error(`[Tenant ${this.tenantId}] Webhook call failed:`, err);
                });
            } catch (err) {
                console.error(`[Tenant ${this.tenantId}] Error handling message event:`, err);
            }
        });
    }

    requireConnected() {
        if (this.status !== 'CONNECTED') {
            throw new Error('WhatsApp client is not connected');
        }
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

    async getStatus() {
        let qrImage = null;
        if (this.qrCode) {
            try {
                qrImage = await QRCode.toDataURL(this.qrCode);
            } catch (err) {
                console.error('Error generating QR code image:', err);
            }
        }
        return {
            status: this.status,
            connectedAt: this.connectedAt,
            qrCode: qrImage
        };
    }

    async sendMessage(to, text, mediaData = null) {
        this.requireConnected();
        if (mediaData) {
            const media = new MessageMedia(
                mediaData.mimetype,
                mediaData.data,
                mediaData.filename || 'file'
            );
            return this.client.sendMessage(to, media, { caption: text });
        }
        return this.client.sendMessage(to, text);
    }

    async logout() {
        if (this.client) {
            try {
                await this.client.logout();
            } catch (error) {
                console.error(`[Tenant ${this.tenantId}] Error during logout:`, error);
            }
            this.status = 'DISCONNECTED';
            this.qrCode = null;
            this.connectedAt = null;
        }
    }
}

// ============================================================
// Export a single default instance (matches base image interface)
// Also expose manager-like methods for multi-tenant support
// ============================================================
const defaultInstance = new WhatsAppService('default');

// Auto-initialize on startup
defaultInstance.initialize().catch((err) => {
    console.error('[Default] Failed to initialize on startup:', err.message);
});

// Expose manager-compatible interface for backward compatibility
defaultInstance.get = async (tenantId) => {
    if (!tenantId || tenantId === 'default') return defaultInstance;
    return defaultInstance;
};

defaultInstance.getOrCreateInstance = async (tenantId) => {
    return defaultInstance;
};

defaultInstance.activeTenants = () => {
    return [['default', defaultInstance]].entries();
};

defaultInstance.destroy = async (tenantId) => {
    await defaultInstance.logout();
};

module.exports = defaultInstance;
