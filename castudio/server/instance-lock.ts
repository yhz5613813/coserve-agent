import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/** `<STUDIO_DATA_DIR>/castudio.lock`: the CAStudio process that owns the data directory. */
export type LockRecord = { pid: number; parentPid: number; instance: string | null; startedAt: string };
/** Another live CAStudio (with a live parent) owns the data directory; index.ts exits with code 75. */
export class LockHeld extends Error {}

export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
/** Executable name of a running pid, or null when it cannot be read. A recycled pid of another program must not count as a CAStudio holder. */
function image(pid: number): string | null {
  try {
    if (process.platform === 'win32') return /^"([^"]+)"/.exec(execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).trim())?.[1] ?? null;
    return path.basename(execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim()) || null;
  } catch { return null; }
}
const holderAlive = (pid: number) => {
  if (!alive(pid)) return false;
  const name = image(pid);
  return name === null || path.basename(process.execPath).toLowerCase().startsWith(name.toLowerCase());
};

/**
 * What a starting server does with an existing lock record: `take` when it is unreadable or its holder is gone,
 * `kill` when the holder is alive but its parent (the desktop) is dead, `exit` when holder and parent are both alive.
 */
export function lockDecision(record: LockRecord | null, holderLive: (pid: number) => boolean, parentLive: (pid: number) => boolean): 'take' | 'kill' | 'exit' {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0 || record.pid === process.pid || !holderLive(record.pid)) return 'take';
  return Number.isInteger(record.parentPid) && record.parentPid > 0 && parentLive(record.parentPid) ? 'exit' : 'kill';
}

const parse = (text: string): LockRecord | null => { try { const value = JSON.parse(text); return value && typeof value === 'object' ? value as LockRecord : null; } catch { return null; } };
const read = (file: string) => fs.readFile(file, 'utf8').then(parse, error => { if (error.code === 'ENOENT') return null; throw error; });
const delay = (ms: number) => new Promise(ok => setTimeout(ok, ms));
async function gone(pid: number, ms: number) { for (const end = Date.now() + ms; Date.now() < end; await delay(100)) if (!alive(pid)) return true; return !alive(pid); }
/** Stops an orphaned holder and its process tree; throws when it is still running after about 10 s. */
async function terminate(pid: number) {
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGTERM'); } catch { /* ESRCH: it exited already */ } if (!await gone(pid, 3000)) { try { process.kill(pid, 'SIGKILL'); } catch { /* ESRCH: it exited meanwhile */ } } }
  if (!await gone(pid, 10000)) throw new LockHeld(`无法结束遗留的 CAStudio 进程 ${pid}`);
}

/**
 * Takes `<dataDir>/castudio.lock` for this process (see lockDecision); throws LockHeld when another live instance owns it.
 * @returns a synchronous release that removes the file only while it still names this pid (safe in an `exit` handler).
 */
export async function acquireLock(dataDir: string, instance: string | null): Promise<() => void> {
  const file = path.join(dataDir, 'castudio.lock');
  await fs.mkdir(dataDir, { recursive: true });
  const record: LockRecord = { pid: process.pid, parentPid: process.ppid, instance, startedAt: new Date().toISOString() };
  for (let attempt = 0; ; attempt++) {
    try { await fs.writeFile(file, JSON.stringify(record), { flag: 'wx' }); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 4) throw error; }
    const existing = await read(file), decision = lockDecision(existing, holderAlive, alive);
    if (decision === 'exit') throw new LockHeld(`数据目录 ${dataDir} 正由另一个 CAStudio 进程 ${existing!.pid}（实例 ${existing!.instance ?? '未知'}）使用`);
    if (decision === 'kill') { console.error(`CAStudio: stopping orphaned instance ${existing!.pid} whose parent ${existing!.parentPid} has exited`); await terminate(existing!.pid); }
    // Remove only the record that was judged; a concurrent starter may have replaced it meanwhile.
    if ((await read(file))?.pid === existing?.pid) await fs.rm(file, { force: true });
  }
  return () => { try { if (parse(readFileSync(file, 'utf8'))?.pid === process.pid) unlinkSync(file); } catch { /* already removed or unreadable: nothing of ours to remove */ } };
}
