import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface SiteSettings {
  openGraphTitle?: string;
  openGraphDescription?: string;
  openGraphImage?: string;
  googleAnalyticsId?: string;
  metaPixelId?: string;
  googleSiteVerification?: string;
  bingSiteVerification?: string;
  aboveHeaderCode?: string;
}

export class SiteSettingsStore {
  private readonly filePath: string;
  private settings: SiteSettings = {};
  private initialized = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) { this.filePath = join(dataDirectory, 'site-settings.json'); }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Site settings must be an object');
      this.settings = sanitizeSettings(parsed as Record<string, unknown>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  get(): SiteSettings { return { ...this.settings }; }

  async update(input: unknown): Promise<SiteSettings> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be a JSON object.');
    this.settings = sanitizeSettings(input as Record<string, unknown>);
    const contents = JSON.stringify(this.settings, null, 2);
    const next = this.persistQueue.catch(() => undefined).then(async () => {
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    this.persistQueue = next;
    await next;
    return this.get();
  }
}

function sanitizeSettings(input: Record<string, unknown>): SiteSettings {
  const read = (key: string, pattern: RegExp): string | undefined => {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string' || raw.length > 200 || !pattern.test(raw)) throw new Error(`Invalid ${key} value.`);
    return raw;
  };
  const readText = (key: string, maxLength: number): string | undefined => {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > maxLength) {
      throw new Error(`Invalid ${key} value.`);
    }
    return raw.trim();
  };
  const openGraphImage = readText('openGraphImage', 2_000);
  if (openGraphImage) {
    const isLocalPath = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(openGraphImage)
      && !openGraphImage.split('/').includes('..');
    let isHttpsUrl = false;
    try {
      const url = new URL(openGraphImage);
      isHttpsUrl = url.protocol === 'https:' && !url.username && !url.password && !url.hash;
    } catch { /* A valid same-site root-relative image path is also accepted. */ }
    if (!isLocalPath && !isHttpsUrl) throw new Error('Open Graph image must be a root-relative path or an absolute HTTPS URL.');
  }
  const aboveHeaderCode = input.aboveHeaderCode;
  if (aboveHeaderCode !== undefined && aboveHeaderCode !== null && aboveHeaderCode !== '') {
    if (typeof aboveHeaderCode !== 'string' || aboveHeaderCode.length > 12_000) {
      throw new Error('Above Header Code must be 12,000 characters or fewer.');
    }
    if (/<\s*(?:iframe|object|embed|form|base|style|link)\b|\son[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html|<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(aboveHeaderCode)) {
      throw new Error('Above Header Code may only contain safe script, meta, and link tags; event handlers, style blocks, embedded content, refresh redirects, and unsafe URLs are blocked.');
    }
    for (const match of aboveHeaderCode.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
      const value = match[2]!.trim();
      if (/^(?:javascript:|data:|vbscript:|\/\/)/i.test(value)) throw new Error('Above Header Code contains an unsafe URL.');
      if (/^(?:https?:)?\/\//i.test(value) && !/^https:\/\//i.test(value)) throw new Error('External Above Header Code URLs must use HTTPS.');
    }
  }
  return {
    ...(readText('openGraphTitle', 120) ? { openGraphTitle: readText('openGraphTitle', 120) } : {}),
    ...(readText('openGraphDescription', 300) ? { openGraphDescription: readText('openGraphDescription', 300) } : {}),
    ...(openGraphImage ? { openGraphImage } : {}),
    ...(read('googleAnalyticsId', /^G-[A-Z0-9]{4,20}$/i) ? { googleAnalyticsId: read('googleAnalyticsId', /^G-[A-Z0-9]{4,20}$/i)!.toUpperCase() } : {}),
    ...(read('metaPixelId', /^\d{5,20}$/) ? { metaPixelId: read('metaPixelId', /^\d{5,20}$/)! } : {}),
    ...(read('googleSiteVerification', /^[A-Za-z0-9_-]{8,200}$/) ? { googleSiteVerification: read('googleSiteVerification', /^[A-Za-z0-9_-]{8,200}$/)! } : {}),
    ...(read('bingSiteVerification', /^[A-Za-z0-9_-]{8,200}$/) ? { bingSiteVerification: read('bingSiteVerification', /^[A-Za-z0-9_-]{8,200}$/)! } : {}),
    ...(typeof aboveHeaderCode === 'string' && aboveHeaderCode ? { aboveHeaderCode } : {})
  };
}
