const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || './redrabbit.db';
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';

if (!fs.existsSync(DB_PATH)) {
    console.error(`✗ Database not found: ${DB_PATH}`);
    process.exit(1);
}

if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const db = new Database(DB_PATH, { readonly: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(BACKUP_DIR, `redrabbit-manual-${timestamp}.db`);

try {
    db.backup(backupPath);
    const size = fs.statSync(backupPath).size;
    console.log(`✓ Backup created: ${backupPath}`);
    console.log(`  Size: ${(size / 1024).toFixed(2)} KB`);
    db.close();
} catch (e) {
    console.error('✗ Backup failed:', e);
    db.close();
    process.exit(1);
}