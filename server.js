'use strict';

const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');

const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
}));

app.use((req, res, next) => {
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (len > 2 * 1024 * 1024) {
        return res.status(413).json({ success: false, error: 'Request body too large' });
    }
    next();
});

app.use(express.json({ limit: '2mb' }));

const globalLimiter = rateLimit({
    windowMs:        60 * 1000,
    max:             300,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { success: false, error: 'Too many requests — please slow down.' },
    skip:            (req) => req.method === 'OPTIONS',
});

const writeLimiter = rateLimit({
    windowMs:        60 * 1000,
    max:             60,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { success: false, error: 'Too many write requests — please slow down.' },
});

const vaultCreateLimiter = rateLimit({
    windowMs:        60 * 1000,
    max:             10,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { success: false, error: 'Too many vault creation requests.' },
});

const nukeLimiter = rateLimit({
    windowMs:        60 * 1000,
    max:             3,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { success: false, error: 'Too many nuke requests.' },
});

const readLimiter = rateLimit({
    windowMs:        60 * 1000,
    max:             1800,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { success: false, error: 'Too many read requests — please slow down.' },
});

app.use('/api', globalLimiter);

function isValidId(s) {
    
    return typeof s === 'string' &&
           s.length >= 8 && s.length <= 512 &&
           /^[\x20-\x7E]+$/.test(s);
}

function isValidUserId(s) {
    
    return typeof s === 'string' &&
           s.length >= 16 && s.length <= 128 &&
           /^[A-Za-z0-9+/=_-]+$/.test(s);
}

const vaults   = new Map();

const messages = new Map();

const MAX_MESSAGES_PER_VAULT = 2000;
const MESSAGE_TTL_MS         = 7 * 24 * 60 * 60 * 1000; 

function getVaultMsgs(vaultId) {
    if (!messages.has(vaultId)) messages.set(vaultId, []);
    return messages.get(vaultId);
}

setInterval(() => {
    const cutoff = Date.now() - MESSAGE_TTL_MS;

    for (const [vaultId, msgs] of messages) {
        const vault            = vaults.get(vaultId);
        const participantCount = vault ? vault.participants.size : 0;

        const pruned = msgs.filter(m => {
            if (m.timestamp < cutoff) return false;                                           
            if (participantCount > 0 && m.acknowledged.size >= participantCount) return false; 
            return true;
        });

        if (pruned.length !== msgs.length) messages.set(vaultId, pruned);

        if (pruned.length === 0 && (!vault || vault.participants.size === 0)) {
            messages.delete(vaultId);
            vaults.delete(vaultId);
        }
    }
}, 60 * 60 * 1000);

app.post('/api/vault_create', [writeLimiter, vaultCreateLimiter], (req, res) => {
    const { vaultId, vaultType } = req.body || {};

    if (!isValidId(vaultId)) {
        return res.status(400).json({ success: false, error: 'invalid vaultId' });
    }

    if (!vaults.has(vaultId)) {
        const t = vaultType === 'private' ? 'private' : 'public';
        vaults.set(vaultId, {
            createdAt:       Date.now(),
            type:            t,
            participants:    new Set(),
            maxParticipants: t === 'private' ? 2 : Infinity,
        });
        messages.set(vaultId, []);
    }

    return res.json({ success: true });
});

app.post('/api/vault_join', (req, res) => {
    const { vaultId, userId, vaultType } = req.body || {};

    if (!isValidId(vaultId) || !isValidUserId(userId)) {
        return res.status(400).json({ success: false, error: 'invalid vaultId or userId' });
    }

    if (!vaults.has(vaultId)) {
        
        const t = vaultType === 'private' ? 'private' : 'public';
        vaults.set(vaultId, {
            createdAt:       Date.now(),
            type:            t,
            participants:    new Set(),
            maxParticipants: t === 'private' ? 2 : Infinity,
        });
        messages.set(vaultId, []);
    }

    const vault = vaults.get(vaultId);

    if (
        vault.type === 'private' &&
        vault.participants.size >= vault.maxParticipants &&
        !vault.participants.has(userId)
    ) {
        return res.status(403).json({
            success: false,
            error:   'Private vault is full (max 2 participants).',
        });
    }

    vault.participants.add(userId);
    getVaultMsgs(vaultId);

    return res.json({
        success:          true,
        participantCount: vault.participants.size,
        vaultType:        vault.type,
    });
});

app.post('/api/vault_leave', (req, res) => {
    return res.json({ success: true });
});

app.post('/api/message', writeLimiter, (req, res) => {
    const { id, vaultId, blob } = req.body || {};

    if (!isValidId(id) || !isValidId(vaultId)) {
        return res.status(400).json({ success: false, error: 'invalid id or vaultId' });
    }
    if (typeof blob !== 'string' || blob.length === 0) {
        return res.status(400).json({ success: false, error: 'blob must be a non-empty string' });
    }
    if (blob.length > 1_000_000) {
        return res.status(413).json({ success: false, error: 'blob exceeds 1 MB limit' });
    }

    const list = getVaultMsgs(vaultId);

    if (list.some(m => m.id === id)) {
        return res.json({ success: true, timestamp: Date.now() });
    }

    const timestamp = Date.now();
    list.push({ id, vaultId, blob, timestamp, acknowledged: new Set() });

    if (list.length > MAX_MESSAGES_PER_VAULT) {
        list.splice(0, list.length - MAX_MESSAGES_PER_VAULT);
    }

    return res.json({ success: true, timestamp });
});

app.post('/api/get_messages', readLimiter, (req, res) => {
    const { vaultId, since } = req.body || {};

    if (!isValidId(vaultId)) {
        return res.status(400).json({ success: false, error: 'invalid vaultId' });
    }

    const list   = getVaultMsgs(vaultId);
    const cutoff = (typeof since === 'number' && since > 0) ? since : 0;

    const serialized = list
        .filter(m => m.timestamp > cutoff)
        .map(m => ({ id: m.id, vaultId: m.vaultId, blob: m.blob, timestamp: m.timestamp }));

    const vault            = vaults.get(vaultId);
    const participantCount = vault ? vault.participants.size : 0;

    return res.json({ success: true, data: serialized, participantCount });
});

app.post('/api/ack_messages', (req, res) => {
    const { vaultId, messageIds, userId } = req.body || {};

    if (!isValidId(vaultId) || !Array.isArray(messageIds) || !isValidUserId(userId)) {
        return res.status(400).json({ success: false, error: 'invalid parameters' });
    }
    if (messageIds.length > 500) {
        return res.status(400).json({ success: false, error: 'too many messageIds (max 500)' });
    }

    const list             = getVaultMsgs(vaultId);
    const vault            = vaults.get(vaultId);
    const participantCount = vault ? vault.participants.size : 0;
    const toDelete         = new Set();

    for (const msgId of messageIds) {
        if (typeof msgId !== 'string') continue;
        const msg = list.find(m => m.id === msgId);
        if (!msg) continue;
        msg.acknowledged.add(userId);
        if (participantCount > 0 && msg.acknowledged.size >= participantCount) {
            toDelete.add(msgId);
        }
    }

    if (toDelete.size > 0) {
        messages.set(vaultId, list.filter(m => !toDelete.has(m.id)));
    }

    return res.json({ success: true });
});

app.post('/api/get_participant_count', readLimiter, (req, res) => {
    const { vaultId } = req.body || {};

    if (!isValidId(vaultId)) {
        return res.status(400).json({ success: false, error: 'invalid vaultId' });
    }

    const vault            = vaults.get(vaultId);
    const participantCount = vault ? vault.participants.size : 0;

    return res.json({ success: true, participantCount });
});

app.post('/api/nuke_user', nukeLimiter, (req, res) => {
    const { vaultIds, userId } = req.body || {};

    if (!Array.isArray(vaultIds)) return res.json({ success: true });

    for (const vid of vaultIds) {
        if (typeof vid !== 'string') continue;

        const vault = vaults.get(vid);

        if (!vault) {
            
            continue;
        }

        if (vault.type === 'private') {
            
            messages.delete(vid);
            vaults.delete(vid);

        } else {
            
            const list             = getVaultMsgs(vid);
            const participantCount = vault.participants.size; 
            const toDelete         = new Set();

            for (const msg of list) {
                msg.acknowledged.add(userId);
                
                const othersAcked = msg.acknowledged.size; 
                if (participantCount > 1 && othersAcked >= participantCount) {
                    toDelete.add(msg.id);
                }
            }

            if (toDelete.size > 0) {
                messages.set(vid, list.filter(m => !toDelete.has(m.id)));
            }

            vault.participants.delete(userId);

            if (vault.participants.size === 0) {
                messages.delete(vid);
                vaults.delete(vid);
            }
        }
    }

    return res.json({ success: true });
});

app.post('/api', (req, res, next) => {
    const { type } = req.body || {};
    if (!type || typeof type !== 'string') {
        return res.status(400).json({ success: false, error: 'missing type' });
    }

    const allowed = [
        'vault_create', 'vault_join', 'vault_leave',
        'message', 'get_messages', 'ack_messages',
        'get_participant_count', 'nuke_user',
    ];

    if (!allowed.includes(type)) {
        return res.status(400).json({ success: false, error: `unknown type: ${type}` });
    }

    req.url = `/api/${type}`;
    app.handle(req, res, next);
});

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: Date.now() });
});

app.get('/admin/stats', (_req, res) => {
    let totalMessages     = 0;
    let totalParticipants = 0;
    let privateVaults     = 0;
    let publicVaults      = 0;

    for (const msgs of messages.values()) totalMessages += msgs.length;
    for (const v of vaults.values()) {
        totalParticipants += v.participants.size;
        v.type === 'private' ? privateVaults++ : publicVaults++;
    }

    res.json({
        vaults: vaults.size, privateVaults, publicVaults,
        messages: totalMessages, totalParticipants,
        uptime: Math.floor(process.uptime()),
    });
});

app.use((_req, res) => {
    res.status(404).json({ success: false, error: 'not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nRedRabbit relay v2.4  port=${PORT}`);
    console.log('Blobs:  opaque AES-GCM only — server is blind to all content.');
    console.log('Limits: global 300/min | write 60/min | create 10/min | nuke 3/min | read 1800/min');
    console.log('TTL:    messages auto-deleted on full-ack OR after 7 days.\n');
});