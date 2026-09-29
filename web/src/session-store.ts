export type AccessFileHandle = {
  kind: 'file'; name: string; getFile(): Promise<File>;
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
};
export type AccessDirectoryHandle = {
  kind: 'directory'; name: string;
  entries(): AsyncIterableIterator<[string, AccessHandle]>;
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
};
export type AccessHandle = AccessFileHandle | AccessDirectoryHandle;
export type SourceHandle = { id: string; handle: AccessHandle };
export type SavedUiState = {
  settings: Record<string, unknown>;
  selected: Record<string, boolean>;
  exportMode: 'zip' | 'individual';
  removedIds: string[];
  targetSsim?: number;
  variantSsim?: Record<string, number>;
  imageSsim?: Record<string, number>;
  inheritsPageSsim?: Record<string, boolean>;
};

const DATABASE = 'image-review-session';
const VERSION = 1;
const SOURCES = 'sources';
const STATE = 'state';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SOURCES)) db.createObjectStore(SOURCES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STATE)) db.createObjectStore(STATE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open image session storage'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Image session storage failed'));
  });
}

export async function loadSession(): Promise<{ sources: SourceHandle[]; state: SavedUiState | null }> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([SOURCES, STATE], 'readonly');
    const [sources, state] = await Promise.all([
      requestResult(tx.objectStore(SOURCES).getAll() as IDBRequest<SourceHandle[]>),
      requestResult(tx.objectStore(STATE).get('current') as IDBRequest<{ key: string; value: SavedUiState } | undefined>),
    ]);
    return { sources, state: state?.value || null };
  } finally { db.close(); }
}

export async function saveSources(sources: SourceHandle[]): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(SOURCES, 'readwrite');
    const store = tx.objectStore(SOURCES);
    store.clear();
    for (const source of sources) store.put(source);
    await transactionDone(tx);
  } finally { db.close(); }
}

export async function saveUiState(value: SavedUiState): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STATE, 'readwrite');
    tx.objectStore(STATE).put({ key: 'current', value });
    await transactionDone(tx);
  } finally { db.close(); }
}

export async function clearSession(): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([SOURCES, STATE], 'readwrite');
    tx.objectStore(SOURCES).clear();
    tx.objectStore(STATE).clear();
    await transactionDone(tx);
  } finally { db.close(); }
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Image session storage failed'));
    tx.onabort = () => reject(tx.error || new Error('Image session storage was interrupted'));
  });
}
