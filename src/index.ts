import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { handleInteraction } from './discord/interaction-handler.js';
import { registerCommands } from './discord/register-commands.js';
import { logger } from './logger.js';
import { BroadcastifyApiProvider } from './providers/broadcastify.js';
import { SubscriptionStore } from './storage/subscription-store.js';
import { AccountStore } from './storage/account-store.js';
import { SiteSettingsStore } from './storage/site-settings-store.js';
import { DashboardServer } from './web/dashboard-server.js';
import { DashboardStore } from './services/dashboard-store.js';
import { CallAnalysisPipeline, OpenAiTriageProvider, WhisperCppTranscriber } from './providers/ai.js';
import { CallProcessor } from './services/call-processor.js';
import { CallFeedPoller } from './services/call-feed-poller.js';
import { BroadcastifyAudioRetriever } from './providers/broadcastify-audio.js';
import { BroadcastifyStaticStreamMonitor } from './providers/broadcastify-static-stream.js';
import { NominatimIncidentGeocoder } from './providers/map-geocoder.js';
import { LearningLog } from './services/learning-log.js';
import { DeploymentUpdater } from './services/deployment-updater.js';
import { XApiIncidentPublisher } from './providers/x-post.js';
import { SourceCallLedger } from './services/source-call-ledger.js';
import { IncidentVoteStore } from './services/incident-vote-store.js';
import { WebhookDeliveryProvider } from './providers/webhook-delivery.js';
import { IncidentDatabase } from './storage/incident-database.js';

const store = new SubscriptionStore(config.dataDir);
const accountStore = new AccountStore(config.dataDir);
const webhookDelivery = new WebhookDeliveryProvider(accountStore, config.dashboardPublicUrl);
const siteSettingsStore = new SiteSettingsStore(config.dataDir);
const learningLog = new LearningLog(config.dataDir, config.aiLearningLogEnabled, config.aiLearningLogRetentionDays, config.aiLearningLogMaxEvents);
const sourceCallLedger = new SourceCallLedger(config.dataDir);
const incidentVoteStore = new IncidentVoteStore(config.dataDir, 'nycalert.sqlite');
const incidentDatabase = new IncidentDatabase(config.dataDir);
const deploymentUpdater = new DeploymentUpdater(config.dataDir);
const xPublisher = config.xUserAccessToken
  ? new XApiIncidentPublisher({ kind: 'oauth2-user', userAccessToken: config.xUserAccessToken })
  : config.xOAuthConsumerKey && config.xOAuthConsumerSecret && config.xOAuthAccessToken && config.xOAuthAccessTokenSecret
    ? new XApiIncidentPublisher({
      kind: 'oauth1-user',
      consumerKey: config.xOAuthConsumerKey,
      consumerSecret: config.xOAuthConsumerSecret,
      accessToken: config.xOAuthAccessToken,
      accessTokenSecret: config.xOAuthAccessTokenSecret
    })
    : undefined;
const dashboardStore = new DashboardStore(config.dashboardPublicAudio, 300, config.dashboardPublicTranscripts, 100, incidentDatabase);
const dashboard = new DashboardServer(dashboardStore, config.dashboardPort, config.dashboardHost, config.applicationId, accountStore, {
  publicUrl: config.dashboardPublicUrl,
  trustProxy: config.trustProxy,
  adminEmail: config.adminEmail,
  adminPassword: config.adminPassword,
  smtpHost: config.smtpHost,
  smtpPort: config.smtpPort,
  smtpSecure: config.smtpSecure,
  smtpUsername: config.smtpUsername,
  smtpPassword: config.smtpPassword,
  smtpFrom: config.smtpFrom
}, siteSettingsStore, learningLog, deploymentUpdater, xPublisher, incidentVoteStore, config.dashboardReadApiOrigins);
const incidentGeocoder = new NominatimIncidentGeocoder(config.mapGeocoderContact);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let feedPoller: CallFeedPoller | undefined;
let staticStreamMonitor: BroadcastifyStaticStreamMonitor | undefined;

await store.init();
await learningLog.init();
await sourceCallLedger.init();
await incidentVoteStore.init();
await dashboardStore.init();
await dashboard.start();

if (!config.xAutoPostEnabled) {
  logger.info('X incident auto-posting is disabled');
} else {
  const xAuthMode = config.xUserAccessToken ? 'oauth2-user'
    : config.xOAuthConsumerKey && config.xOAuthConsumerSecret && config.xOAuthAccessToken && config.xOAuthAccessTokenSecret ? 'oauth1-user'
      : 'missing-credentials';
  logger.info({ xAuthMode }, 'X incident auto-posting configuration loaded');
}

client.once(Events.ClientReady, async (readyClient) => {
  logger.info({ user: readyClient.user.tag }, 'Discord bot is ready');
  try {
    await registerCommands();
  } catch (error) {
    logger.error({ error }, 'Could not register slash commands');
  }

  const provider = new BroadcastifyApiProvider(
      config.broadcastifyBaseUrl,
      config.broadcastifyJwtKeyId,
      config.broadcastifyJwtIssuer,
      config.broadcastifyJwtSecret,
      config.broadcastifyFeedMap
  );
  dashboardStore.setFeedStatusProvider(() => [
    ...provider.getFeedStatuses(),
    ...(staticStreamMonitor?.getFeedStatus() ?? [])
  ]);

  if (config.callsEnabled || config.liveEnabled || config.broadcastifyNypdStreamEnabled) {
    if (!config.openAiApiKey) {
      logger.error('Feed processing is enabled but OPENAI_API_KEY is missing; AI triage is disabled');
      const diagnostic = {
        state: 'error' as const,
        stage: 'Analysis pipeline not started: OPENAI_API_KEY is missing',
        callsProcessed: 0,
        callsRetried: 0,
        callsFailed: 0,
        lastError: 'Configure OPENAI_API_KEY to enable transcription triage and summaries.'
      };
      if (config.callsEnabled || config.liveEnabled) dashboardStore.setPipelineDiagnostics(diagnostic, 'calls-api');
      if (config.broadcastifyNypdStreamEnabled) dashboardStore.setPipelineDiagnostics(diagnostic, 'nypd-static');
      return;
    }
    const analysis = new CallAnalysisPipeline(
      new WhisperCppTranscriber(config.whisperModelPath, config.whisperExecutablePath, config.whisperThreads, undefined, config.ffmpegPath),
      new OpenAiTriageProvider(config.openAiApiKey, config.triageModel)
    );
    const processor = new CallProcessor(client, store, analysis, dashboardStore, config.broadcastifyAudioRedistributionAllowed, 0.78, config.newsworthinessThreshold, incidentGeocoder, config.buffInterestThreshold, config.newsMediaDeskThreshold, learningLog, config.xAutoPostEnabled ? xPublisher : undefined, config.dashboardPublicUrl, config.xPostDelayMs, sourceCallLedger, webhookDelivery);
    dashboard.setPendingIncidentAdminHandlers(
      () => processor.listPendingIncidents(),
      (pendingId) => processor.discardPendingIncident(pendingId),
      (pendingId) => processor.allowPendingIncident(pendingId)
    );
    if (config.callsEnabled || config.liveEnabled) {
      const audioRetriever = new BroadcastifyAudioRetriever({
        dataDirectory: config.dataDir,
        apiBaseUrl: config.broadcastifyBaseUrl ?? 'https://api.bcfy.io',
        allowedHosts: config.broadcastifyAudioAllowedHosts,
        maxBytes: config.broadcastifyAudioMaxBytes
      });
      feedPoller = new CallFeedPoller(
        provider,
        processor,
        audioRetriever,
        config.dashboardPublicAudio,
        config.broadcastifyPollIntervalMs,
        dashboardStore,
        config.dashboardPublicAudio || config.broadcastifyAudioRedistributionAllowed
      );
      feedPoller.start();
      logger.info({ configuredPlaylists: config.broadcastifyFeedMap.length, pollIntervalMs: config.broadcastifyPollIntervalMs }, 'Broadcastify Calls API polling and Whisper pipeline started');
    }
    if (config.broadcastifyNypdStreamEnabled) {
      if (!config.broadcastifyStaticUsername || !config.broadcastifyStaticPassword) {
        logger.error('NYPD static stream is enabled but BROADCASTIFY_STATIC_USERNAME or BROADCASTIFY_STATIC_PASSWORD is missing');
        dashboardStore.setPipelineDiagnostics({
          state: 'error',
          stage: 'NYPD stream not started: Basic-auth credentials are missing',
          callsProcessed: 0,
          callsRetried: 0,
          callsFailed: 0,
          lastError: 'Set BROADCASTIFY_STATIC_USERNAME and BROADCASTIFY_STATIC_PASSWORD in the protected environment.'
        }, 'nypd-static');
      } else {
        staticStreamMonitor = new BroadcastifyStaticStreamMonitor({
          feedId: config.broadcastifyNypdFeedId,
          username: config.broadcastifyStaticUsername,
          password: config.broadcastifyStaticPassword,
          dataDirectory: config.dataDir,
          ffmpegPath: config.ffmpegPath,
          segmentSeconds: config.broadcastifyNypdSegmentSeconds,
          processor,
          dashboard: dashboardStore
        });
        staticStreamMonitor.start();
        logger.info({ feedId: config.broadcastifyNypdFeedId, segmentSeconds: config.broadcastifyNypdSegmentSeconds }, 'NYPD authenticated static stream monitor started');
      }
    }
  } else {
    logger.info('Feed ingestion is disabled; set up the approved Broadcastify integration before enabling it');
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleInteraction(interaction, store);
  } catch (error) {
    logger.error({ error, command: interaction.commandName }, 'Slash command failed');
    const response = { content: 'The command failed. Check the bot logs for details.', flags: MessageFlags.Ephemeral as const };
    if (interaction.replied || interaction.deferred) await interaction.followUp(response).catch(() => undefined);
    else await interaction.reply(response).catch(() => undefined);
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'Shutting down');
    void learningLog.flush();
    sourceCallLedger.close();
    incidentVoteStore.close();
    dashboardStore.close();
    feedPoller?.stop();
    void staticStreamMonitor?.stop();
    void dashboard.stop();
    client.destroy();
    process.exit(0);
  });
}

await client.login(config.discordToken);
