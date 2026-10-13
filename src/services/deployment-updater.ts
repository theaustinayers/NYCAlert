import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export interface DeploymentUpdateStatus {
  state: 'not-configured' | 'idle' | 'queued' | 'updating' | 'succeeded' | 'failed';
  requestedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  commit?: string;
  message: string;
}

interface DeploymentUpdaterOptions {
  statusPath?: string;
  installedPaths?: string[];
  queuedTimeoutMs?: number;
}

export class DeploymentUpdater {
  private readonly statusPath: string;
  private readonly installedPaths: string[];
  private readonly queuedTimeoutMs: number;
  private lastRequestAt = 0;

  private readonly requestPath: string;

  constructor(dataDirectory: string, options: DeploymentUpdaterOptions = {}) {
    this.statusPath = options.statusPath ?? '/var/lib/nyc-alert-updater/status.json';
    this.installedPaths = options.installedPaths ?? [
      '/usr/local/sbin/nyc-alert-update',
      '/etc/systemd/system/nyc-alert-updater.path',
      '/etc/systemd/system/nyc-alert-updater.service'
    ];
    this.queuedTimeoutMs = options.queuedTimeoutMs ?? 120_000;
    this.requestPath = join(dataDirectory, 'update-request');
  }

  async getStatus(): Promise<DeploymentUpdateStatus> {
    if (!await this.isInstalled()) {
      return { state: 'not-configured', message: 'Update service is not installed on this server yet.' };
    }
    const [requestAt, status] = await Promise.all([
      readFile(this.requestPath, 'utf8').catch(() => ''),
      this.readStatus()
    ]);
    const queuedAt = Date.parse(requestAt.trim());
    if (requestAt) {
      const statusAt = Date.parse(status?.state === 'updating' ? status.startedAt ?? '' : status?.finishedAt ?? '');
      if (status && Number.isFinite(queuedAt) && status.state !== 'idle' && statusAt >= queuedAt) return status;
      if (Number.isFinite(queuedAt) && Date.now() - queuedAt >= this.queuedTimeoutMs) {
        return {
          state: 'failed',
          requestedAt: requestAt.trim(),
          finishedAt: new Date(queuedAt + this.queuedTimeoutMs).toISOString(),
          message: 'The protected updater did not start within two minutes. Check nyc-alert-updater.path and nyc-alert-updater.service on the server; refresh to retry after the stale request is cleared.'
        };
      }
      return { state: 'queued', requestedAt: requestAt.trim(), message: 'Update queued and waiting for the protected system updater.' };
    }
    return status ?? { state: 'idle', message: 'Ready to check GitHub main for an update.' };
  }

  async trigger(): Promise<DeploymentUpdateStatus> {
    if (!await this.isInstalled()) throw new Error('Safe GitHub updater is not configured on this server.');
    const prior = await this.getStatus();
    if (prior.state === 'updating' || prior.state === 'queued') throw new Error('An update is already queued or running.');
    if (Date.now() - this.lastRequestAt < 30_000) throw new Error('Please wait 30 seconds before requesting another update.');
    this.lastRequestAt = Date.now();
    try {
      if (await this.hasRequest()) {
        if (prior.state !== 'failed') throw new Error('An update is already queued.');
        await unlink(this.requestPath).catch(() => undefined);
      }
      await mkdir(dirname(this.requestPath), { recursive: true, mode: 0o750 });
      const requestedAt = new Date().toISOString();
      const temp = `${this.requestPath}.${randomUUID()}.tmp`;
      await writeFile(temp, `${requestedAt}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temp, this.requestPath);
      return { state: 'queued', requestedAt, message: 'Update queued. The protected updater will fetch GitHub main, build, health-check, and roll back application files on failure.' };
    } catch (error) {
      throw new Error(`Could not start the protected update service: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async hasRequest(): Promise<boolean> {
    try { await access(this.requestPath); return true; }
    catch { return false; }
  }

  private async readStatus(): Promise<DeploymentUpdateStatus | null> {
    try { return JSON.parse(await readFile(this.statusPath, 'utf8')) as DeploymentUpdateStatus; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    }
  }

  private async isInstalled(): Promise<boolean> {
    try {
      await Promise.all(this.installedPaths.map((path) => access(path)));
      return true;
    } catch { return false; }
  }

}
