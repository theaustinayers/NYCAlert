export const boroughs = ['Manhattan', 'Bronx', 'Queens', 'Brooklyn', 'Staten Island'] as const;
export const agencies = ['FDNY', 'NYPD'] as const;

export type Borough = (typeof boroughs)[number];
export type Agency = (typeof agencies)[number];
export const alertAudiences = ['public', 'buff', 'news'] as const;
export type AlertAudience = (typeof alertAudiences)[number];

export interface AlertSubscription {
  guildId: string;
  channelId: string;
  borough: Borough;
  agency: Agency;
  audience?: AlertAudience;
  notifyRoleId?: string;
}

export function subscriptionAudience(subscription: Pick<AlertSubscription, 'audience'>): AlertAudience {
  return subscription.audience ?? 'news';
}

export function isBorough(value: string): value is Borough {
  return boroughs.some((borough) => borough.toLowerCase() === value.toLowerCase());
}

export function isAgency(value: string): value is Agency {
  return agencies.some((agency) => agency.toLowerCase() === value.toLowerCase());
}

export function matchesSubscription(
  subscription: AlertSubscription,
  call: { borough: Borough; agency: Agency }
): boolean {
  return subscription.borough === call.borough && subscription.agency === call.agency;
}
