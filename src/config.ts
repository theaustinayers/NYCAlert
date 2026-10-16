import 'dotenv/config';
import { z } from 'zod';
import { parseFeedMap } from './providers/broadcastify.js';

const optionalText = (schema: z.ZodTypeAny) => z.preprocess((value) => value === '' ? undefined : value, schema.optional());

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().optional(),
  BROADCASTIFY_API_BASE_URL: z.string().url().optional(),
  BROADCASTIFY_JWT_KEY_ID: z.string().optional(),
  BROADCASTIFY_JWT_ISSUER: z.string().optional(),
  BROADCASTIFY_JWT_SECRET: z.string().optional(),
  BROADCASTIFY_NYPD_FEED_ID: z.string().default('47753'),
  BROADCASTIFY_STATIC_USERNAME: z.string().optional(),
  BROADCASTIFY_STATIC_PASSWORD: z.string().optional(),
  BROADCASTIFY_NYPD_STREAM_ENABLED: z.string().default('false'),
  BROADCASTIFY_NYPD_SEGMENT_SECONDS: z.coerce.number().int().min(10).max(120).default(90),
  BROADCASTIFY_FEED_MAP: z.string().default('[]'),
  BROADCASTIFY_AUDIO_ALLOWED_HOSTS: z.string().default(''),
  BROADCASTIFY_AUDIO_MAX_BYTES: z.coerce.number().int().min(1024).max(100 * 1024 * 1024).default(20 * 1024 * 1024),
  BROADCASTIFY_CALLS_ENABLED: z.string().default('false'),
  BROADCASTIFY_LIVE_ENABLED: z.string().default('false'),
  BROADCASTIFY_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  OPENAI_API_KEY: z.string().optional(),
  ADMIN_EMAIL: optionalText(z.string().email()),
  ADMIN_PASSWORD: optionalText(z.string().min(16)),
  WHISPER_CPP_PATH: z.string().default('/opt/whisper.cpp/build/bin/whisper-cli'),
  WHISPER_MODEL_PATH: z.string().default('/opt/whisper.cpp/models/ggml-base.en.bin'),
  WHISPER_THREADS: z.coerce.number().int().min(1).max(64).default(2),
  FFMPEG_PATH: z.string().default('/usr/bin/ffmpeg'),
  NEWSWORTHINESS_THRESHOLD: z.coerce.number().int().min(1).max(5).default(4),
  BUFF_INTEREST_THRESHOLD: z.coerce.number().int().min(1).max(5).default(4),
  NEWS_MEDIA_DESK_THRESHOLD: z.coerce.number().int().min(1).max(5).default(4),
  BROADCASTIFY_AUDIO_REDISTRIBUTION_ALLOWED: z.string().default('false'),
  X_AUTO_POST_ENABLED: z.string().default('false'),
  X_POST_DELAY_SECONDS: z.coerce.number().int().min(0).max(300).default(60),
  X_USER_ACCESS_TOKEN: optionalText(z.string().min(1)),
  X_OAUTH_CONSUMER_KEY: optionalText(z.string().min(1)),
  X_OAUTH_CONSUMER_SECRET: optionalText(z.string().min(1)),
  X_OAUTH_ACCESS_TOKEN: optionalText(z.string().min(1)),
  X_OAUTH_ACCESS_TOKEN_SECRET: optionalText(z.string().min(1)),
  TRIAGE_MODEL: z.string().default('gpt-4o-mini'),
  DASHBOARD_HOST: z.string().default('0.0.0.0'),
  DASHBOARD_PUBLIC_URL: z.string().url().default('https://nycalert.ai'),
  DASHBOARD_READ_API_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.string().default('false'),
  DASHBOARD_PORT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.coerce.number().int().min(1).max(65535).default(Number(process.env.SERVER_PORT ?? process.env.PORT ?? 8080))
  ),
  DASHBOARD_PUBLIC_AUDIO: z.string().default('false'),
  DASHBOARD_PUBLIC_TRANSCRIPTS: z.string().default('false'),
  MAP_GEOCODER_CONTACT: z.preprocess((value) => value === '' ? undefined : value, z.string().email().optional()),
  AI_LEARNING_LOG_ENABLED: z.string().default('false'),
  AI_LEARNING_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  AI_LEARNING_LOG_MAX_EVENTS: z.coerce.number().int().min(100).max(100_000).default(20_000),
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
  throw new Error(`Invalid environment configuration (${missing}). Copy .env.example to .env and configure required Discord values.`);
}
if (Boolean(parsed.data.ADMIN_EMAIL) !== Boolean(parsed.data.ADMIN_PASSWORD)) {
  throw new Error('Configure both ADMIN_EMAIL and ADMIN_PASSWORD to enable the administrator dashboard.');
}
if (parsed.data.X_AUTO_POST_ENABLED === 'true' && !parsed.data.X_USER_ACCESS_TOKEN) {
  const oauth1 = [parsed.data.X_OAUTH_CONSUMER_KEY, parsed.data.X_OAUTH_CONSUMER_SECRET, parsed.data.X_OAUTH_ACCESS_TOKEN, parsed.data.X_OAUTH_ACCESS_TOKEN_SECRET];
  if (!oauth1.every(Boolean)) throw new Error('X_AUTO_POST_ENABLED requires either an OAuth2 user token or all four X OAuth 1.0a user credentials.');
}
const configuredOAuth1Values = [parsed.data.X_OAUTH_CONSUMER_KEY, parsed.data.X_OAUTH_CONSUMER_SECRET, parsed.data.X_OAUTH_ACCESS_TOKEN, parsed.data.X_OAUTH_ACCESS_TOKEN_SECRET];
if (configuredOAuth1Values.some(Boolean) && !configuredOAuth1Values.every(Boolean)) {
  throw new Error('Configure all four X OAuth 1.0a user credentials, or leave all four empty.');
}
if (parsed.data.X_AUTO_POST_ENABLED === 'true' && parsed.data.X_USER_ACCESS_TOKEN && configuredOAuth1Values.some(Boolean)) {
  throw new Error('Configure either X_USER_ACCESS_TOKEN or OAuth 1.0a user credentials, not both.');
}

function parseReadApiOrigins(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    let url: URL;
    try { url = new URL(item); } catch { throw new Error('DASHBOARD_READ_API_ORIGINS must contain comma-separated HTTPS origins.'); }
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!localHttp && url.protocol !== 'https:') || url.origin !== item || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new Error('DASHBOARD_READ_API_ORIGINS entries must be exact HTTPS origins (HTTP is allowed only for localhost development).');
    }
    return url.origin;
  });
}

export const config = {
  discordToken: parsed.data.DISCORD_TOKEN,
  applicationId: parsed.data.DISCORD_APPLICATION_ID,
  guildId: parsed.data.DISCORD_GUILD_ID,
  broadcastifyBaseUrl: parsed.data.BROADCASTIFY_API_BASE_URL,
  broadcastifyJwtKeyId: parsed.data.BROADCASTIFY_JWT_KEY_ID,
  broadcastifyJwtIssuer: parsed.data.BROADCASTIFY_JWT_ISSUER,
  broadcastifyJwtSecret: parsed.data.BROADCASTIFY_JWT_SECRET,
  broadcastifyNypdFeedId: parsed.data.BROADCASTIFY_NYPD_FEED_ID,
  broadcastifyStaticUsername: parsed.data.BROADCASTIFY_STATIC_USERNAME,
  broadcastifyStaticPassword: parsed.data.BROADCASTIFY_STATIC_PASSWORD,
  broadcastifyNypdStreamEnabled: parsed.data.BROADCASTIFY_NYPD_STREAM_ENABLED === 'true',
  broadcastifyNypdSegmentSeconds: parsed.data.BROADCASTIFY_NYPD_SEGMENT_SECONDS,
  broadcastifyFeedMap: parseFeedMap(parsed.data.BROADCASTIFY_FEED_MAP),
  broadcastifyAudioAllowedHosts: parsed.data.BROADCASTIFY_AUDIO_ALLOWED_HOSTS.split(',').map((host) => host.trim()).filter(Boolean),
  broadcastifyAudioMaxBytes: parsed.data.BROADCASTIFY_AUDIO_MAX_BYTES,
  callsEnabled: parsed.data.BROADCASTIFY_CALLS_ENABLED === 'true',
  liveEnabled: parsed.data.BROADCASTIFY_LIVE_ENABLED === 'true',
  broadcastifyPollIntervalMs: parsed.data.BROADCASTIFY_POLL_INTERVAL_MS,
  openAiApiKey: parsed.data.OPENAI_API_KEY,
  adminEmail: parsed.data.ADMIN_EMAIL?.toLowerCase(),
  adminPassword: parsed.data.ADMIN_PASSWORD,
  whisperExecutablePath: parsed.data.WHISPER_CPP_PATH,
  whisperModelPath: parsed.data.WHISPER_MODEL_PATH,
  whisperThreads: parsed.data.WHISPER_THREADS,
  ffmpegPath: parsed.data.FFMPEG_PATH,
  newsworthinessThreshold: parsed.data.NEWSWORTHINESS_THRESHOLD,
  buffInterestThreshold: parsed.data.BUFF_INTEREST_THRESHOLD,
  newsMediaDeskThreshold: parsed.data.NEWS_MEDIA_DESK_THRESHOLD,
  broadcastifyAudioRedistributionAllowed: parsed.data.BROADCASTIFY_AUDIO_REDISTRIBUTION_ALLOWED === 'true',
  xAutoPostEnabled: parsed.data.X_AUTO_POST_ENABLED === 'true',
  xPostDelayMs: parsed.data.X_POST_DELAY_SECONDS * 1000,
  xUserAccessToken: parsed.data.X_USER_ACCESS_TOKEN,
  xOAuthConsumerKey: parsed.data.X_OAUTH_CONSUMER_KEY,
  xOAuthConsumerSecret: parsed.data.X_OAUTH_CONSUMER_SECRET,
  xOAuthAccessToken: parsed.data.X_OAUTH_ACCESS_TOKEN,
  xOAuthAccessTokenSecret: parsed.data.X_OAUTH_ACCESS_TOKEN_SECRET,
  triageModel: parsed.data.TRIAGE_MODEL,
  dashboardHost: parsed.data.DASHBOARD_HOST,
  dashboardPublicUrl: parsed.data.DASHBOARD_PUBLIC_URL.replace(/\/$/, ''),
  dashboardReadApiOrigins: parseReadApiOrigins(parsed.data.DASHBOARD_READ_API_ORIGINS),
  trustProxy: parsed.data.TRUST_PROXY === 'true',
  dashboardPort: parsed.data.DASHBOARD_PORT,
  dashboardPublicAudio: parsed.data.DASHBOARD_PUBLIC_AUDIO === 'true',
  dashboardPublicTranscripts: parsed.data.DASHBOARD_PUBLIC_TRANSCRIPTS === 'true',
  mapGeocoderContact: parsed.data.MAP_GEOCODER_CONTACT,
  aiLearningLogEnabled: parsed.data.AI_LEARNING_LOG_ENABLED === 'true',
  aiLearningLogRetentionDays: parsed.data.AI_LEARNING_LOG_RETENTION_DAYS,
  aiLearningLogMaxEvents: parsed.data.AI_LEARNING_LOG_MAX_EVENTS,
  dataDir: parsed.data.DATA_DIR,
  logLevel: parsed.data.LOG_LEVEL
} as const;
