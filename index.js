// ============================================================
//  AUTOMATED DIGITAL NOTICE BOARD — main application file
//  Baileys (WhatsApp) + Express/Socket.IO (web) + SQLite (storage)
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
const { DatabaseSync } = require('node:sqlite'); // built into Node.js

// ---------- Settings (read from .env, with fallbacks) ----------
const PORT = process.env.PORT || 3000;
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID || ''; // e.g. 120363xxxxxxxxxx@g.us
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const ADMIN_PHONE_NUMBERS = (process.env.ADMIN_PHONE_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

const NOTICE_KEYWORDS = (
  process.env.NOTICE_KEYWORDS ||
  'notice,exam,holiday,reminder,circular,postponed,timetable,schedule,announcement,last date,submission,students,student,informed,without fail,immediately,dear,hackathons'
)
  .split(',')
  .map((k) => k.trim().toLowerCase())
  .filter(Boolean);

// ---------- Folders & files we depend on ----------
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const DB_FILE = path.join(__dirname, 'data', 'notices.db');
const AUTH_DIR = path.join(__dirname, 'baileys_auth');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(DB_FILE))) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// ---------- Set up the SQLite database ----------
const db = new DatabaseSync(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    caption TEXT,
    sender TEXT,
    timestamp INTEGER NOT NULL,
    category TEXT DEFAULT 'general'
  )
`);

// Safety net: if you're upgrading an older database that predates the
// "category" column, add it now. Harmless to run every time — it just
// does nothing once the column already exists.
try {
  db.exec(`ALTER TABLE notices ADD COLUMN category TEXT DEFAULT 'general'`);
} catch (err) {
  if (!String(err.message).includes('duplicate column name')) throw err;
}

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

// A quiet logger — Baileys requires one, but we don't want its
// internal chatter cluttering our terminal.
const silentLogger = pino({ level: 'silent' });

// Holds the WhatsApp connection once it's ready. Declared here (not
// inside startBot) so our admin-command helper functions below can
// also use it to send replies.
let sock;

// Remembers the notice IDs shown by the last "list" command, so
// "delete 2" knows which real notice that refers to.
let lastListedNoticeIds = [];

// ---------- Small helper functions ----------
const ADMIN_COMMAND_PREFIX = '!';

function stripCommandPrefix(text) {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith(ADMIN_COMMAND_PREFIX)) return null;
  return trimmed.slice(ADMIN_COMMAND_PREFIX.length).trim();
}

function looksLikeNotice(text) {
  const lower = text.toLowerCase();
  return NOTICE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function extractPhoneNumber(jid) {
  return jid ? jid.split('@')[0].split(':')[0] : '';
}

async function handleAdminCommand(command, chatId) {
  const lower = command.toLowerCase();

  if (lower === 'list' || lower === 'notices') {
    const notices = getAllNoticesStmt.all().slice(0, 10);
    lastListedNoticeIds = notices.map((n) => n.id);

    if (notices.length === 0) {
      await sock.sendMessage(chatId, { text: 'No active notices right now.' });
      return;
    }

    const lines = notices.map((n, i) => {
      const preview =
        n.mimetype === 'text/plain'
          ? n.caption.slice(0, 40)
          : `[${n.mimetype.startsWith('image/') ? 'image' : 'file'}] ${n.caption.slice(0, 30)}`;
      return `${i + 1}. ${preview} — ${n.sender}`;
    });

    await sock.sendMessage(chatId, {
      text: `📋 Current notices:\n\n${lines.join('\n')}\n\nReply "!delete <number>" to remove one.`,
    });
    return;
  }

  const deleteMatch = lower.match(/^delete\s+(\d+)$/);
  if (deleteMatch) {
    const index = Number(deleteMatch[1]) - 1;
    const noticeId = lastListedNoticeIds[index];

    if (noticeId === undefined) {
      await sock.sendMessage(chatId, { text: '⚠️ Invalid number — send "!list" first.' });
      return;
    }

    const notice = getNoticeByIdStmt.get(noticeId);
    if (!notice) {
      await sock.sendMessage(chatId, { text: '⚠️ Already removed.' });
      return;
    }

    if (notice.filename) {
      const filepath = path.join(DOWNLOADS_DIR, notice.filename);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }
    deleteNoticeStmt.run(notice.id);
    io.emit('removeNotice', notice.id);

    await sock.sendMessage(chatId, { text: `✅ Deleted notice ${deleteMatch[1]}.` });
    return;
  }

  await sock.sendMessage(chatId, {
    text: 'Commands:\n"!list" — show current notices\n"!delete <number>" — remove one',
  });
}

// ============================================================
//  PART 1: THE WEB SERVER (backend + display API)
// ============================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(DOWNLOADS_DIR));

app.get('/api/notices', (req, res) => {
  const notices = getAllNoticesStmt.all();
  res.json(notices);
});

app.delete('/api/notices/:id', (req, res) => {
  const providedPassword = req.headers['x-admin-password'];
  if (providedPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const idToDelete = Number(req.params.id);
  const noticeToDelete = getNoticeByIdStmt.get(idToDelete);
  if (!noticeToDelete) {
    return res.status(404).json({ error: 'Notice not found' });
  }

  if (noticeToDelete.filename) {
    const filepath = path.join(DOWNLOADS_DIR, noticeToDelete.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  }

  deleteNoticeStmt.run(idToDelete);
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
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger: silentLogger,
  });

  sock.ev.on('creds.update', saveCreds);

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
        startBot();
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

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;

        const chatId = msg.key.remoteJid;
        const messageType = Object.keys(msg.message)[0];
        const isImage = messageType === 'imageMessage';
        const isDocument = messageType === 'documentMessage';
        const isText = messageType === 'conversation' || messageType === 'extendedTextMessage';
        const textBody = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        const isGroupMessage = chatId.endsWith('@g.us');

        // --- DEBUG LOGGING (safe to remove later) ---
        console.log('--- message received ---');
        console.log('Chat ID:', chatId, '| Group?', isGroupMessage, '| Type:', messageType);
        console.log('-------------------------');

        // --- Private admin command channel (never touches the group) ---
        if (!isGroupMessage) {
          if (!isText) continue; // ignore media sent privately

          // WhatsApp's new "Linked Identity" system sometimes fails to
          // tell us which private chat a message actually belongs to —
          // a known upstream bug, not something we can fix here. So
          // instead of trusting WHICH chat this is, we trust WHO could
          // have sent it: fromMe=true can ONLY happen on your own
          // linked account, and we require a distinctive command
          // prefix so ordinary texting is never mistaken for a command.
          const senderNumber = extractPhoneNumber(msg.key.participant || chatId);
          const isTrusted = msg.key.fromMe || ADMIN_PHONE_NUMBERS.includes(senderNumber);
          if (!isTrusted) continue;

          const command = stripCommandPrefix(textBody);
          if (command === null) continue; // ordinary private chat — not a command

          await handleAdminCommand(command, chatId);
          continue;
        }

        // Rule: must be OUR specific target group
        if (TARGET_GROUP_ID && chatId !== TARGET_GROUP_ID) continue;

        // --- Image or document notices ---
        if (isImage || isDocument) {
          console.log(`📩 New file detected in "${chatId}" — downloading...`);

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
            notice.id, notice.filename, notice.mimetype,
            notice.caption, notice.sender, notice.timestamp
          );

          io.emit('newNotice', notice);
          console.log(`✅ Saved and broadcast: ${filename}\n`);
          continue;
        }

        // --- Plain text notices (keyword-detected) ---
        if (isText) {
          if (!looksLikeNotice(textBody)) {
            console.log('💬 Text message ignored (no notice keyword found).\n');
            continue;
          }

          const notice = {
            id: Date.now(),
            filename: '',
            mimetype: 'text/plain',
            caption: textBody,
            sender: msg.pushName || 'Unknown',
            timestamp: Date.now(),
          };

          insertNoticeStmt.run(
            notice.id, notice.filename, notice.mimetype,
            notice.caption, notice.sender, notice.timestamp
          );

          io.emit('newNotice', notice);
          console.log(`✅ Text notice saved and broadcast: "${textBody.slice(0, 50)}"\n`);
          continue;
        }
      } catch (err) {
        console.error('🔥 Error while handling a message:', err);
      }
    }
  });
}

startBot();