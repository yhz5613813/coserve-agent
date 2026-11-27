import { watch, promises as fs } from 'node:fs';
import path from 'node:path';

/** Directories nobody edits as project artifacts; dot-entries (`.studio`, `.git`, ...) are ignored separately. */
const ignoredNames = new Set(['node_modules', '__pycache__', 'venv']);
const DEBOUNCE_MS = 300, SCAN_MS = 2000, SCAN_DEPTH = 6, SCAN_LIMIT = 5000, MAX_PATHS = 200;

export interface WatchOptions {
  /** `native` uses recursive fs.watch (macOS/Windows); `scan` polls an mtime/size snapshot (default on Linux). */
  mode?: 'native' | 'scan';
  debounceMs?: number;
  scanMs?: number;
}

/** Whether a workspace-relative POSIX path is outside the watched artifact set. */
const skipped = (relative: string, skipTop: ReadonlySet<string>) => relative.split('/').some((name, index) => name.startsWith('.') || ignoredNames.has(name) || (index === 0 && skipTop.has(name)));

async function snapshot(root: string, skipTop: ReadonlySet<string>) {
  const files = new Map<string, string>();
  const visit = async (dir: string, depth: number) => {
    if (depth > SCAN_DEPTH) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (files.size >= SCAN_LIMIT) return;
      const file = path.join(dir, entry.name), relative = path.relative(root, file).split(path.sep).join('/');
      if (entry.isSymbolicLink() || skipped(relative, skipTop)) continue;
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile()) { const stat = await fs.stat(file).catch(() => null); if (stat) files.set(relative, `${stat.mtimeMs}:${stat.size}`); }
    }
  };
  await visit(root, 0).catch(() => {});
  return files;
}

/**
 * Report changed workspace-relative paths (debounced) when files under `root` change behind CAStudio's back.
 * `skipTop` lists top-level folders owned by someone else (a root project's `parts/`). `paths` is undefined when the OS did not name the files or too many changed.
 * Returns the stop function.
 */
export function watchWorkspace(root: string, skipTop: ReadonlySet<string>, onChange: (paths?: string[]) => void, options: WatchOptions = {}): () => void {
  const { mode = process.platform === 'linux' ? 'scan' : 'native', debounceMs = DEBOUNCE_MS, scanMs = SCAN_MS } = options;
  let pending = new Set<string>(), unknown = false, timer: NodeJS.Timeout | undefined, stopped = false;
  const flush = () => {
    timer = undefined;
    if (stopped) return;
    const paths = !unknown && pending.size <= MAX_PATHS ? [...pending].sort() : undefined;
    pending = new Set(); unknown = false;
    onChange(paths);
  };
  const touch = (relative?: string) => {
    if (relative === undefined) unknown = true;
    else if (skipped(relative, skipTop)) return;
    else pending.add(relative);
    timer ??= setTimeout(flush, debounceMs);
  };
  const cleanup = () => { stopped = true; clearTimeout(timer); };
  if (mode === 'native') {
    const watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => touch(name === null ? undefined : name.toString().split(path.sep).join('/')));
    watcher.on('error', () => watcher.close());
    return () => { cleanup(); watcher.close(); };
  }
  let previous: Map<string, string> | undefined, scanning = false;
  const scan = async () => {
    if (scanning) return;
    scanning = true;
    const next = await snapshot(root, skipTop);
    scanning = false;
    if (stopped) return;
    if (previous) {
      for (const [file, signature] of next) if (previous.get(file) !== signature) touch(file);
      for (const file of previous.keys()) if (!next.has(file)) touch(file);
    }
    previous = next;
  };
  void scan();
  const interval = setInterval(scan, scanMs); interval.unref();
  return () => { cleanup(); clearInterval(interval); };
}
