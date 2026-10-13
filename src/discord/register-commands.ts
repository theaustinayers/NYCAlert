import { REST, Routes } from 'discord.js';
import { config } from '../config.js';
import { commands } from './commands.js';
import { logger } from '../logger.js';

export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.applicationId, config.guildId)
    : Routes.applicationCommands(config.applicationId);
  await rest.put(route, { body: commands });
  logger.info({ scope: config.guildId ? 'guild' : 'global' }, 'Discord slash commands registered');
}
