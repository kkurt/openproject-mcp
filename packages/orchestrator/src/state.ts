/**
 * Persistent run state at `.openproject-agent/state.json`. Idempotent: a work
 * package that reached a terminal status is skipped on the next run. Writes are
 * atomic (temp file + rename).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type WorkPackageStatus = 'in_progress' | 'done' | 'blocked' | 'failed' | 'needs_review';

export interface WorkPackageState {
  status: WorkPackageStatus;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  changedFiles?: string[];
  result?: string;
  error?: string;
}

export interface StateFile {
  version: 1;
  workPackages: Record<string, WorkPackageState>;
}

const TERMINAL: WorkPackageStatus[] = ['done', 'blocked', 'failed', 'needs_review'];

function emptyState(): StateFile {
  return { version: 1, workPackages: {} };
}

export class StateStore {
  readonly dir: string;
  readonly file: string;
  private data: StateFile = emptyState();

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, 'state.json');
  }

  async load(): Promise<StateFile> {
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8')) as StateFile;
      if (!this.data.workPackages) this.data = emptyState();
    } catch {
      this.data = emptyState();
    }
    return this.data;
  }

  get(id: number | string): WorkPackageState | undefined {
    return this.data.workPackages[String(id)];
  }

  all(): StateFile {
    return this.data;
  }

  /** A WP is "processed" (skip on resume) once it reached a terminal status. */
  isProcessed(id: number | string): boolean {
    const s = this.get(id);
    return s !== undefined && TERMINAL.includes(s.status);
  }

  async set(id: number | string, patch: WorkPackageState): Promise<void> {
    this.data.workPackages[String(id)] = { ...this.data.workPackages[String(id)], ...patch };
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(tmp, this.file);
  }

  async clear(): Promise<void> {
    this.data = emptyState();
    await this.persist();
  }
}
