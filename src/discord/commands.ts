import { SlashCommandBuilder } from 'discord.js';
import { agencies, alertAudiences, boroughs } from '../domain/subscriptions.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('alerts')
    .setDescription('Manage borough and agency alerts for this channel')
    .addSubcommand((subcommand) => subcommand.setName('add').setDescription('Subscribe this channel to a feed')
      .addStringOption((option) => option.setName('borough').setDescription('NYC borough').setRequired(true).addChoices(...boroughs.map((value) => ({ name: value, value }))))
      .addStringOption((option) => option.setName('agency').setDescription('Agency').setRequired(true).addChoices(...agencies.map((value) => ({ name: value, value }))))
      .addStringOption((option) => option.setName('audience').setDescription('Alert audience (defaults to Public)').setRequired(false).addChoices(...alertAudiences.map((value) => ({ name: value === 'news' ? 'News Media' : value === 'buff' ? 'Buff' : 'Public', value }))))
      .addRoleOption((option) => option.setName('notify_role').setDescription('Optional role to mention for matching alerts').setRequired(false))
    )
    .addSubcommand((subcommand) => subcommand.setName('remove').setDescription('Unsubscribe this channel from a feed')
      .addStringOption((option) => option.setName('borough').setDescription('NYC borough').setRequired(true).addChoices(...boroughs.map((value) => ({ name: value, value }))))
      .addStringOption((option) => option.setName('agency').setDescription('Agency').setRequired(true).addChoices(...agencies.map((value) => ({ name: value, value }))))
      .addStringOption((option) => option.setName('audience').setDescription('Audience to remove (defaults to News Media for existing channels)').setRequired(false).addChoices(...alertAudiences.map((value) => ({ name: value === 'news' ? 'News Media' : value === 'buff' ? 'Buff' : 'Public', value }))))
    )
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('Show this channel’s subscriptions'))
    .toJSON()
];
