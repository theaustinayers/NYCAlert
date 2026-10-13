import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { subscriptionAudience, type AlertSubscription, type Agency, type Borough } from '../domain/subscriptions.js';

export class SubscriptionStore {
  private subscriptions: AlertSubscription[] = [];
  private readonly filePath: string;
  private initialized = false;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'subscriptions.json');
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const data: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!Array.isArray(data)) throw new Error('Subscription store must contain a JSON array');
      this.subscriptions = data as AlertSubscription[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.subscriptions = [];
    }
    this.initialized = true;
  }

  list(guildId: string, channelId?: string): AlertSubscription[] {
    return this.subscriptions.filter((item) => item.guildId === guildId && (!channelId || item.channelId === channelId));
  }

  listForCall(call: { borough: Borough | 'Citywide'; agency: Agency }): AlertSubscription[] {
    return this.subscriptions.filter((item) => (call.borough === 'Citywide' || item.borough === call.borough) && item.agency === call.agency);
  }

  async add(subscription: AlertSubscription): Promise<boolean> {
    const existingIndex = this.subscriptions.findIndex((item) => this.same(item, subscription));
    if (existingIndex >= 0) {
      const existing = this.subscriptions[existingIndex]!;
      const audience = subscriptionAudience(subscription);
      const updated = {
        ...existing,
        ...(audience === 'news' ? { audience: undefined } : { audience }),
        ...(subscription.notifyRoleId ? { notifyRoleId: subscription.notifyRoleId } : { notifyRoleId: undefined })
      };
      if (existing.notifyRoleId === updated.notifyRoleId) return false;
      if (audience === 'news') delete updated.audience;
      if (!updated.notifyRoleId) delete updated.notifyRoleId;
      this.subscriptions[existingIndex] = updated;
      await this.persist();
      return true;
    }
    const stored = { ...subscription };
    if (subscriptionAudience(stored) === 'news') delete stored.audience;
    this.subscriptions.push(stored);
    await this.persist();
    return true;
  }

  async remove(guildId: string, channelId: string, borough: Borough, agency: Agency, audience: 'public' | 'news' | 'buff' = 'news'): Promise<boolean> {
    const previousLength = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((item) => !this.same(item, { guildId, channelId, borough, agency, audience }));
    if (this.subscriptions.length === previousLength) return false;
    await this.persist();
    return true;
  }

  private same(left: AlertSubscription, right: AlertSubscription): boolean {
    return left.guildId === right.guildId && left.channelId === right.channelId
      && left.borough === right.borough && left.agency === right.agency
      && subscriptionAudience(left) === subscriptionAudience(right);
  }

  private async persist(): Promise<void> {
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.subscriptions, null, 2), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
