// ============================================================
//  AUTOMATED DIGITAL NOTICE BOARD — main application file
//  Now powered by Baileys instead of whatsapp-web.js.
//  Baileys talks WhatsApp's own network protocol directly —
//  no hidden browser involved — so it isn't affected by the
//  "r: r" website-scraping bugs we hit earlier.
// ============================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built into Node.js — no npm install needed

// ---------- Settings (read from .env, with fallbacks) ----------
const PORT = process.env.PORT || 3000;
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID || ''; // e.g. 120363xxxxxxxxxx@g.us

// ---------- Folders & files we depend on ----------
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const DB_FILE = path.join(__dirname, 'data', 'notices.db');
const OLD_JSON_FILE = path.join(__dirname, 'data', 'notices.json'); // only used for one-time migration
const AUTH_DIR = path.join(__dirname, 'baileys_auth');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(DB_FILE))) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// ---------- Set up the SQLite database ----------
const db = new DatabaseSync(DB_FILE);

// CREATE TABLE defines the shape of our data — its columns and their types.
// "IF NOT EXISTS" means this is safe to run every time the app starts;
// it only actually creates the table the very first time.
db.exec(`
  CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    caption TEXT,
    sender TEXT,
    timestamp INTEGER NOT NULL
  )
`);

// Prepared statements: pre-written questions with "?" blanks we fill in
// safely later. Preparing them once up front is more efficient than
// re-writing the SQL text every single time we use it.
const insertNoticeStmt = db.prepare(`
  INSERT INTO notices (id, filename, mimetype, caption, sender, timestamp)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const getAllNoticesStmt = db.prepare(`
  SELECT * FROM notices ORDER BY timestamp DESC
`);
const getNoticeByIdStmt = db.prepare(`
  SELECT * FROM notices WHERE id = ?
`);
const deleteNoticeStmt = db.prepare(`
  DELETE FROM notices WHERE id = ?
`);

// ---------- One-time migration: bring in old JSON data, if any exists ----------
// This only matters if you were using the old notices.json version before.
// It runs once, safely — if notices.json doesn't exist, it just skips.
if (fs.existsSync(OLD_JSON_FILE)) {
  const alreadyHaveRows = getAllNoticesStmt.all().length > 0;
  if (!alreadyHaveRows) {
    const oldNotices = JSON.parse(fs.readFileSync(OLD_JSON_FILE, 'utf-8'));
    for (const n of oldNotices) {
      insertNoticeStmt.run(n.id, n.filename, n.mimetype, n.caption || '', n.sender || 'Unknown', n.timestamp);
    }
    console.log(`📦 Migrated ${oldNotices.length} old notice(s) from notices.json into SQLite.`);
  }
}

// A quiet logger — Baileys requires one, but we don't want its
// internal chatter cluttering our terminal.
const silentLogger = pino({ level: 'silent' });

// ============================================================
//  PART 1: THE WEB SERVER (backend + display API)
// ============================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(DOWNLOADS_DIR));

app.get('/api/notices', (req, res) => {
  // .all() runs the SELECT and gives back every matching row as an array
  const notices = getAllNoticesStmt.all();
  res.json(notices);
});

// Removes one notice: deletes its database row AND its actual file
app.delete('/api/notices/:id', (req, res) => {
  const idToDelete = Number(req.params.id);

  // .get() runs a SELECT and gives back just ONE row (or undefined)
  const noticeToDelete = getNoticeByIdStmt.get(idToDelete);
  if (!noticeToDelete) {
    return res.status(404).json({ error: 'Notice not found' });
  }

  // Remove the actual file from the downloads folder
  const filepath = path.join(DOWNLOADS_DIR, noticeToDelete.filename);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
  }

  // .run() executes an INSERT/UPDATE/DELETE (anything that changes data,
  // rather than reading it)
  deleteNoticeStmt.run(idToDelete);

  // Tell every open browser tab to remove it from the screen too
  io.emit('removeNotice', idToDelete);

  res.json({ success: true });
});

server.listen(PORT, () => {
  console.log(`\n✅ Web app running: http://localhost:${PORT}\n`);
});

// ============================================================
//  PART 2: THE WHATSAPP BOT (Baileys)
// ============================================================
async function startBot() {
  // useMultiFileAuthState remembers your login between restarts —
  // this is Baileys' equivalent of whatsapp-web.js's LocalAuth.
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: silentLogger,
  });

  // Baileys asks us to save updated login credentials whenever they change.
  sock.ev.on('creds.update', saveCreds);

  // Fires when the connection status changes: QR ready, connected, or dropped.
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp:');
      console.log('   WhatsApp app -> Settings -> Linked Devices -> Link a Device\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log('🔒 Logged out. Delete the baileys_auth folder and restart to log in again.');
      } else {
        console.log('⚠️  Connection dropped — reconnecting...');
        startBot(); // simple auto-reconnect
      }
    } else if (connection === 'open') {
      console.log('🤖 WhatsApp bot connected and listening for notices!');
      console.log(
        TARGET_GROUP_ID
          ? `   Watching only group ID: ${TARGET_GROUP_ID}\n`
          : '   No TARGET_GROUP_ID set yet — watching ALL groups for discovery.\n'
      );
    }
  });

  // Fires whenever new messages arrive.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // "notify" = genuinely new messages (not old history being synced)
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue; // e.g. reactions, deleted messages — skip

        // In Baileys, remoteJid is ALWAYS the chat the message belongs to,
        // regardless of who sent it — no fromMe/@lid confusion like before.
        const chatId = msg.key.remoteJid;

        const isGroupMessage = chatId.endsWith('@g.us');

        // Figure out what kind of message this is (text, image, document, etc.)
        const messageType = Object.keys(msg.message)[0];
        const isImage = messageType === 'imageMessage';
        const isDocument = messageType === 'documentMessage';

        // --- DEBUG LOGGING (safe to remove later) ---
        console.log('--- message received ---');
        console.log('Chat ID:', chatId);
        console.log('fromMe?', msg.key.fromMe);
        console.log('Message type:', messageType);
        console.log('Target group ID expected:', TARGET_GROUP_ID || '(not set yet)');
        console.log('-------------------------');

        // Rule 1: must be a group chat
        if (!isGroupMessage) continue;

        // Rule 2: must be OUR specific group (once TARGET_GROUP_ID is set)
        if (TARGET_GROUP_ID && chatId !== TARGET_GROUP_ID) continue;

        // Rule 3: must be an image or document
        if (!isImage && !isDocument) continue;

        console.log(`📩 New file detected in "${chatId}" — downloading...`);

        // Download the actual file data
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
        );

        const mediaInfo = msg.message[messageType];
        const mimetype = mediaInfo.mimetype || 'application/octet-stream';
        const extension = mimetype.split('/')[1]?.split(';')[0] || 'bin';
        const filename = `notice_${Date.now()}.${extension}`;
        const filepath = path.join(DOWNLOADS_DIR, filename);

        fs.writeFileSync(filepath, buffer);

        const notice = {
          id: Date.now(),
          filename,
          mimetype,
          caption: mediaInfo.caption || '',
          sender: msg.pushName || 'Unknown',
          timestamp: Date.now(),
        };

        insertNoticeStmt.run(
          notice.id,
          notice.filename,
          notice.mimetype,
          notice.caption,
          notice.sender,
          notice.timestamp
        );

        io.emit('newNotice', notice);

        console.log(`✅ Saved and broadcast: ${filename}\n`);
      } catch (err) {
        console.error('🔥 Error while handling a message:', err);
      }
    }
  });
}

startBot();