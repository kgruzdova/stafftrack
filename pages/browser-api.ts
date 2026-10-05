import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { handle } from '../lib/server';
import { env } from './bindings';
import { BrowserDatabase } from './d1-adapter';

const migrations = import.meta.glob('../drizzle/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const STORAGE_NAME = 'stafftrack-pages-v1';
type Snapshot = { bytes?: Uint8Array; session: string; revision: number };
let storagePromise: Promise<IDBDatabase> | undefined;
let sqlPromise: ReturnType<typeof initSqlJs> | undefined;
let queue: Promise<unknown> = Promise.resolve();
const fileUrls = new Map<string, string>();

function storage() {
  return storagePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(STORAGE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('state');
      request.result.createObjectStore('files');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Закройте другие вкладки StaffTrack и обновите страницу.'));
  });
}

async function read<T>(store: string, key: string): Promise<T | undefined> {
  const database = await storage();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, 'readonly');
    const request = transaction.objectStore(store).get(key);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function commit(previous: Snapshot, next: Snapshot, files: Map<string, Blob | null>) {
  const database = await storage();
  return new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(['state', 'files'], 'readwrite');
    const states = transaction.objectStore('state');
    const request = states.get('database');
    let saved = false;
    request.onsuccess = () => {
      if ((request.result?.revision ?? 0) !== previous.revision) return;
      states.put(next, 'database');
      const objects = transaction.objectStore('files');
      for (const [key, file] of files) {
        if (file) objects.put(file, key);
        else objects.delete(key);
      }
      saved = true;
    };
    transaction.oncomplete = () => resolve(saved);
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function clearFileUrls() {
  for (const url of fileUrls.values()) URL.revokeObjectURL(url);
  fileUrls.clear();
}

async function execute(path: string, method: string, body?: unknown): Promise<Response> {
  const SQL = await (sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl }));
  for (let attempt = 0; attempt < 5; attempt++) {
    const previous = await read<Snapshot>('state', 'database') ?? { session: '', revision: 0 };
    const sqlite = new SQL.Database(previous.bytes);
    const database = new BrowserDatabase(sqlite);
    const files = new Map<string, Blob | null>();
    try {
      sqlite.run('PRAGMA foreign_keys=ON');
      sqlite.run('CREATE TABLE IF NOT EXISTS _browser_migrations (name TEXT PRIMARY KEY)');
      for (const [name, sql] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))) {
        if (sqlite.exec('SELECT name FROM _browser_migrations WHERE name=?', [name]).length) continue;
        sqlite.run('BEGIN');
        try {
          sqlite.run(sql);
          sqlite.run('INSERT INTO _browser_migrations (name) VALUES (?)', [name]);
          sqlite.run('COMMIT');
          database.dirty = true;
        } catch (error) { sqlite.run('ROLLBACK'); throw error; }
      }
      env.DB = database as unknown as D1Database;
      env.BUCKET = {
        async put(key: string, bytes: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
          files.set(key, new Blob([bytes], { type: options?.httpMetadata?.contentType }));
        },
        async get(key: string) {
          const blob = files.has(key) ? files.get(key) : await read<Blob>('files', key);
          return blob ? { body: blob } : null;
        },
        async delete(key: string) { files.set(key, null); },
      } as unknown as R2Bucket;
      const form = body instanceof FormData;
      const headers = new Headers();
      if (!form) headers.set('Content-Type', 'application/json');
      const request = new Request('https://stafftrack.local/api/' + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
      });
      // Browser Request strips Cookie as a forbidden network header. This
      // request stays in-process, so pass the local session to our handler
      // through a separate Headers object rather than a network request.
      const localHeaders = new Headers(request.headers);
      if (previous.session) localHeaders.set('Cookie', 'stafftrack_session=' + previous.session);
      let issuedCookie: string | null = null;
      const response = await handle({
        url: request.url, method: request.method, headers: localHeaders,
        json: () => request.json(), formData: () => request.formData(),
      } as Request, cookie => { issuedCookie = cookie; });
      // Browser Response also strips Set-Cookie. Capture the in-process
      // handler's session directly; no cookie is sent over the network.
      const cookie = issuedCookie as string | null;
      const session = cookie === null ? previous.session : cookie.match(/^stafftrack_session=([^;]*)/)?.[1] ?? '';
      if (database.dirty || files.size || session !== previous.session) {
        const saved = await commit(previous, { bytes: sqlite.export(), session, revision: previous.revision + 1 }, files);
        if (!saved) continue;
      }
      if (path === 'auth/logout' || method === 'DELETE') clearFileUrls();
      return response;
    } finally {
      env.DB = undefined;
      env.BUCKET = undefined;
      sqlite.close();
    }
  }
  throw new Error('Данные изменились в другой вкладке. Повторите действие.');
}

function request(path: string, method = 'GET', body?: unknown) {
  const operation = async () => {
    if (navigator.locks) return navigator.locks.request(STORAGE_NAME, () => execute(path, method, body));
    return execute(path, method, body);
  };
  const result = queue.then(operation, operation);
  queue = result.catch(() => {});
  return result;
}

export async function browserApi(path: string, method = 'GET', body?: unknown): Promise<any> {
  if (path === 'auth/forgot' || path === 'auth/reset') {
    throw new Error('В автономной версии нет восстановления по email. Пароль сотрудника может изменить администратор в разделе «Сотрудники».');
  }
  try {
    const response = await request(path, method, body);
    const result = await response.json() as any;
    if (!response.ok) throw Object.assign(new Error(result.error || 'Не удалось выполнить действие'), { status: response.status });
    if (result.attachments) {
      for (const attachment of result.attachments) {
        if (fileUrls.has(attachment.id)) continue;
        const response = await request('files/' + attachment.id);
        if (!response.ok) throw new Error('Не удалось открыть вложение');
        fileUrls.set(attachment.id, URL.createObjectURL(await response.blob()));
      }
    }
    return result;
  } catch (error) {
    if (error instanceof DOMException) {
      throw new Error(error.name === 'QuotaExceededError'
        ? 'В браузере закончилось место. Освободите место и повторите сохранение.'
        : 'Не удалось открыть локальное хранилище. Разрешите сохранение данных для этого сайта.');
    }
    throw error;
  }
}

export const attachmentUrl = (id: string) => fileUrls.get(id) || '#';
window.addEventListener('pagehide', clearFileUrls);
