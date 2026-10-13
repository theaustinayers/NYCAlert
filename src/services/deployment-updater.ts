import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

export class DeploymentUpdater {
  private readonly statusPath: string;
  private lastRequestAt = 0;

  private readonly requestPath: string;

  constructor(dataDirectory: string) {
    this.statusPath = '/var/lib/nyc-alert-updater/status.json';
    this.requestPath = join(dataDirectory, 'update-request');
  }

  async getStatus(): Promise<DeploymentUpdateStatus> {
    if (!await this.isInstalled()) {
      return { state: 'not-configured', message: 'Update service is not installed on this server yet.' };
    }
    const requestAt = await readFile(this.requestPath, 'utf8').catch(() => '');
    if (requestAt) return { state: 'queued', requestedAt: requestAt.trim(), message: 'Update queued and waiting for the protected system updater.' };
    try {
      const status = JSON.parse(await readFile(this.statusPath, 'utf8')) as DeploymentUpdateStatus;
      return status;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { state: 'idle', message: 'Ready to check GitHub main for an update.' };
    }
  }

  async trigger(): Promise<DeploymentUpdateStatus> {
    if (!await this.isInstalled()) throw new Error('Safe GitHub updater is not configured on this server.');
    const prior = await this.getStatus();
    if (prior.state === 'updating' || prior.state === 'queued') throw new Error('An update is already queued or running.');
    if (Date.now() - this.lastRequestAt < 30_000) throw new Error('Please wait 30 seconds before requesting another update.');
    this.lastRequestAt = Date.now();
    try {
      if (await this.hasRequest()) throw new Error('An update is already queued.');
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

  private async isInstalled(): Promise<boolean> {
    try {
      await access('/usr/local/sbin/nyc-alert-update');
      await access('/etc/systemd/system/nyc-alert-updater.path');
      await access('/etc/systemd/system/nyc-alert-updater.service');
      return true;
    } catch { return false; }
  }

}
