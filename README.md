# RedRabbit.

**If they can read it, it isn’t yours.**

A browser-based single html file encrypted messaging app. No accounts, no phone numbers, no servers that can read your messages. You open the HTML file, pick a name, create a vault, share the invite token with someone, and talk. That's it.

The relay server is genuinely blind — it stores encrypted blobs and nothing else. It has no way to decrypt messages, identify users, or link anything to a real person. Even if you handed over the server and its entire contents, nobody could read a single message.

---

## How it works

Every user gets a randomly generated **Ed25519 identity keypair** on first launch. Your User ID is the SHA-256 hash of your public key — so it's derived from who you are cryptographically, not from a username you picked.

Conversations happen inside **vaults**. When you create a vault, an **X25519 keypair** is generated for it on your device and never leaves your browser. Messages are encrypted with a fresh ephemeral X25519 keypair per message (forward secrecy), then signed with your Ed25519 identity key so the recipient can verify the sender.

The server only ever sees:
- An opaque vault ID (random string)
- Opaque encrypted blobs (base64 ciphertext)
- Timestamps and acknowledgement state

No plaintext. No keys. No user info.

---

## Features

**Encryption**
- X25519 ephemeral ECDH per message — full forward secrecy
- AES-256-GCM authenticated encryption
- Ed25519 message signing and verification
- HKDF-SHA256 key derivation
- Everything runs in the browser via WebCrypto — no external crypto libraries

**Vaults**
- **Private vault** — strictly 2 people. The creator and one invitee. No one else can join even with the token.
- **Public vault** — unlimited participants, same encryption model
- Invite tokens start with `RRv1_` and encode the vault's key material so the recipient can immediately decrypt everything

**Message lifecycle**
- Messages are stored on the relay server as encrypted blobs
- Once every participant has acknowledged a message, it's deleted from the server
- Hard 7-day TTL as a fallback for messages that were never acknowledged
- Max 2000 messages per vault before old ones get dropped

**Client storage**
- Everything is stored in IndexedDB — your identity keys, vault memberships, encryption keys, message history
- Nothing in localStorage (except a one-time server list migration)
- Works across tabs but only one tab should be open at a time for the same profile

**Multi-relay support**
- You can point the client at multiple relay servers simultaneously
- Requests go to all of them in parallel; the first successful response wins

**NUKE**
- Wipes your identity keys, all vault data, IndexedDB, and tells every relay to delete your server-side data
- This cannot be undone. The button says so twice.

---

## File structure

```
redrabbit.html   — the entire client application, one file, no build step
server.js        — the relay server
backup.js        — manual backup script for the database
package.json     — server dependencies
```

The client is fully self-contained. You can save it locally, host it anywhere static, or just open it directly in the browser.

---

## Browser requirements

You need a browser that supports X25519 and Ed25519 in the WebCrypto API:

- Chrome / Edge 113+
- Firefox 130+
- Safari 17+

Older browsers won't work. The app checks on load and tells you if yours isn't supported.

---

## Running the relay server

### Prerequisites

- Node.js 18 or newer

### Setup

```bash
npm install
npm start
```

The server starts on port 3000 by default. That's it.

```bash
# Custom port
PORT=8080 npm start

# Watch mode during development (restarts on file changes)
npm run dev
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `DB_PATH` | `./redrabbit.db` | Path to database file (used by backup script) |
| `BACKUP_DIR` | `./backups` | Directory for database backups |

### Rate limits

The server has layered rate limiting out of the box:

| Tier | Limit | Applies to |
|---|---|---|
| Global | 300 req/min per IP | All `/api` routes |
| Writes | 60 req/min per IP | Vault creation, messages, nuke |
| Vault creation | 10 req/min per IP | `/api/vault_create` only |
| Nuke | 3 req/min per IP | `/api/nuke_user` only |
| Reads | 1800 req/min per IP | Message polling |

1800 read requests per minute is generous — a single client polling every 2 seconds uses 30/min, so you have headroom for roughly 60 concurrent clients per IP before it kicks in.

### Health check and stats

```
GET /health        — returns {"status":"ok","ts":...}
GET /admin/stats   — returns vault counts, message counts, uptime
```

`/admin/stats` has no authentication in the current version. Don't expose it publicly without adding something in front of it.

### Production notes

The server uses in-memory Maps for vault and message storage, so everything is lost on restart. Vaults are re-created automatically when clients reconnect (they send the vault type along with the join request so private vaults don't accidentally get re-created as public).

For anything beyond a personal/small group setup you'd want to:
- Put it behind HTTPS — without TLS the blobs are visible in transit, even though they're encrypted, which leaks metadata
- Replace the in-memory store with Redis or a database for persistence across restarts
- Add authentication to `/admin/stats`
- Run it behind a reverse proxy (nginx, Caddy)

### Backups

```bash
npm run backup
```

This runs `backup.js` which creates a timestamped copy of the database in the `./backups` directory. Useful if you're running a persistent database variant.

---

---

A server for testing the app is hosted on 

serverredrabbit-production.up.railway.app

(Can use http://serverredrabbit-production.up.railway.app in configuration to try the app.)

---
## Using the app

### First launch

1. Open `redrabbit.html` in your browser
2. Enter a display name — this is just a label, it's not an account
3. The app generates your Ed25519 identity keypair locally and derives your User ID from it
4. Add your relay server URL (default is `http://localhost:3000`)
5. Hit Continue

Your identity is now stored in IndexedDB. Next time you open the app it'll pick it back up automatically.

### Creating a vault

1. From the main menu, choose **Private Vault** or **Public Vault** from the dropdown
2. Public vaults need a name; private vaults are just called "Private Chat"
3. Hit **Create Vault**
4. You'll land in the chat screen — the invite token is shown at the bottom

### Inviting someone

Copy the invite token from the vault info panel (click it, it copies to clipboard). Send it to whoever you want to invite. It starts with `RRv1_` and is a fairly long string — that's normal, it contains the vault's key material so they can decrypt messages without needing a separate key exchange step.

For private vaults, once a second person joins with the token, the vault is full. Anyone else who tries gets rejected by the server.

### Joining a vault

Paste the `RRv1_...` token into the **Join Vault** field and hit Join. You'll start receiving messages immediately.

### Rejoining

Your joined vaults are listed on the main screen. Clicking **Open** rejoins the vault — you'll get any messages you missed since you were last online, as long as they haven't expired (7 days or fully acknowledged by everyone, whichever comes first).

### Leaving vs Nuking

**Leave Vault** just closes the session locally — you can rejoin anytime and your messages are still there.

**NUKE** (in the Configuration tab) permanently deletes everything: your identity, all vaults, all messages, and wipes the relay server of your data. Use it when you want to disappear completely and start over with a fresh identity.

---

## Multi-relay setup

If you want redundancy or want to split load across servers, you can add multiple relay URLs in the Configuration tab (or on the setup screen). The client sends every request to all relays simultaneously and takes the first successful response. Messages will end up on all relays that are reachable at send time.

---

## Security notes worth knowing

**The invite token contains the vault's private key.** Whoever has the token can decrypt all messages in that vault — past and future. Treat it like a password. Don't post it somewhere public, don't send it over an insecure channel.(This will be changes in next release when the protocol for cross server handshake will be finalized,till then be careful while sharing it).

**Forward secrecy is per-message.** Each message uses a fresh ephemeral X25519 keypair. Compromising the vault's long-term key doesn't expose past messages, but the vault key is in the invite token, so see above.

**The server can see metadata.** It can't read messages but it does see vault IDs, blob sizes, timestamps, and how many participants a vault has. If that's a concern, HTTPS helps with the transit side, but the server will always have some metadata.(Its adviced to use vpn/tor if you want even more privacy).

**Identity keys live in IndexedDB.** Clearing your browser data deletes your identity and you can't recover it. Export or back up your keys if you care about long-term access. There's no recovery mechanism.(Next release will have indexDB data protection from malacious XSS attacks).

---

**Invisible by design. Unstoppable by nature.**
The main reason to design the main app as single html file is so that it can not be prevented/censored by anyone or many.
The app is not hypocrite and for the same reason complete code is open source and anyone can audit it.Anyone can host there own server and can start using it.The project will forever remain free and open source.
The app is made for only one reason and it is to oppose survailence as **Privacy is not an option**.

---

**What the project needs:**
RedRabbit will always be free. If you want to help keep it alive — we're working on hosting a dedicated server on the Tor network so the app remains accessible even in places where the clearnet version might get blocked.Also to host as many free servers as possible(We will add the server urls here itself). That costs money. If this project is useful to you or you just believe in what it's trying to do, a small donation goes a long way.We will try to host as many servers as possible from our side.

**Bitcoin**
[bc1qj5rg8wtg8e5ksacj43pe7nyqmaewkncq75jlr8](bitcoin:bc1qj5rg8wtg8e5ksacj43pe7nyqmaewkncq75jlr8)

**Ethereum**
[0xfc696a5f83b36860e43d15b979bb0f5326a3289d](ethereum:0xfc696a5f83b36860e43d15b979bb0f5326a3289d)

**Solana**
[31PdhUujM4EL17J9Utwdqm773eMzG9VbDxJoNaA68S96](solana:31PdhUujM4EL17J9Utwdqm773eMzG9VbDxJoNaA68S96)

---

To report any problem/vulnerabilities/backdoor/support contact us on
whitepeacock@tutamail.com

---
## Whats next:
The next release will aim to harden encryption.
Cross server handshake protocol.(So two people on diffrent servers can also comunicate)(Will also fix the problem of vaults private key sent over with invite token).
Voice and video calls over WebRTC for private vaults.
Make it less intimidating for less technical users.
Make server as light weight as possible.
