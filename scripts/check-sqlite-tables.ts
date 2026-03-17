import Database from 'better-sqlite3';
import path from 'path';

const sqlite = new Database(path.resolve(process.cwd(), 'db/hr_bot.db'), { readonly: true });
const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables:", tables.map((t: any) => t.name));
