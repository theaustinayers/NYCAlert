import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { isAgency, isBorough, subscriptionAudience } from '../domain/subscriptions.js';
import type { SubscriptionStore } from '../storage/subscription-store.js';

export async function handleInteraction(interaction: ChatInputCommandInteraction, store: SubscriptionStore): Promise<void> {
  if (interaction.commandName !== 'alerts') return;
  if (!interaction.inGuild() || !interaction.channelId) {
    await interaction.reply({ content: 'Use this command in a server text channel.', flags: MessageFlags.Ephemeral });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'list') {
    const subscriptions = store.list(interaction.guildId, interaction.channelId);
    const content = subscriptions.length
      ? subscriptions.map((subscription) => `• ${subscription.borough} — ${subscription.agency} (${audienceLabel(subscriptionAudience(subscription))})${subscription.notifyRoleId ? ` · notify <@&${subscription.notifyRoleId}>` : ''}`).join('\n')
      : 'No alerts are configured for this channel.';
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  const borough = interaction.options.getString('borough', true);
  const agency = interaction.options.getString('agency', true);
  if (!isBorough(borough) || !isAgency(agency)) {
    await interaction.reply({ content: 'Invalid borough or agency.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === 'add') {
    const notifyRole = interaction.options.getRole('notify_role');
    const selectedAudience = interaction.options.getString('audience');
    const audience = selectedAudience === 'buff' || selectedAudience === 'news' ? selectedAudience : 'public';
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const changed = await store.add({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      borough,
      agency,
      audience,
      ...(notifyRole ? { notifyRoleId: notifyRole.id } : {})
    });
    await interaction.editReply({
      content: changed
        ? `Subscribed this channel to ${borough} ${agency} (${audienceLabel(audience)})${notifyRole ? `; matching alerts will mention <@&${notifyRole.id}>` : '. No role mention configured.'}`
        : 'That subscription already has these settings.',
      allowedMentions: { parse: [], roles: [] }
    });
  } else if (subcommand === 'remove') {
    const selectedAudience = interaction.options.getString('audience');
    const audience = selectedAudience === 'buff' || selectedAudience === 'public' ? selectedAudience : 'news';
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const removed = await store.remove(interaction.guildId, interaction.channelId, borough, agency, audience);
    await interaction.editReply({ content: removed ? `Removed ${borough} ${agency} (${audienceLabel(audience)}) from this channel.` : 'That subscription was not configured.' });
  }
}

function audienceLabel(audience: 'public' | 'buff' | 'news'): string {
  return audience === 'buff' ? 'Buff' : audience === 'news' ? 'News Media' : 'Public';
}
