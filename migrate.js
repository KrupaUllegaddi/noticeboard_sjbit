// migrate.js
// One-off script: adds the `category` column to the existing notices table.
// Run once, then you can delete this file.

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const dbPath = path.join(__dirname, 'data', 'notices.db');
const db = new DatabaseSync(dbPath);

try {
  db.exec("ALTER TABLE notices ADD COLUMN category TEXT DEFAULT 'general';");
  console.log('✅ category column added.');
} catch (err) {
  if (String(err.message).includes('duplicate column name')) {
    console.log('ℹ️  category column already exists — nothing to do.');
  } else {
    console.error('❌ Migration failed:', err.message);
  }
}

db.close();