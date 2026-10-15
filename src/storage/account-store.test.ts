import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { AccountStore } from './account-store.js';

const testDirectory = await mkdtemp(join(tmpdir(), 'nyc-accounts-'));
after(async () => rm(testDirectory, { recursive: true, force: true }));

describe('AccountStore', () => {
  it('requires email verification and administrator approval for Buff and News Media accounts', async () => {
    const store = new AccountStore(join(testDirectory, 'approval'));
    await store.init();

    for (const accountType of ['buff', 'news'] as const) {
      const registered = await store.register({
        firstName: 'Test', lastName: accountType, email: `${accountType}@example.test`,
        phone: '2125550100', usageCase: 'Testing audience view account access.',
        accountType, password: 'Strong-test-password-123'
      });

      await assert.rejects(store.login(registered.account.email, 'Strong-test-password-123'), /Verify your email/);
      const verified = await store.verifyEmail(registered.verificationToken);
      assert.equal(verified.status, 'pending-approval');
      await assert.rejects(store.login(verified.email, 'Strong-test-password-123'), /awaiting administrator approval/);

      await store.updateAccount(verified.id, { status: 'approved' });
      const session = await store.login(verified.email, 'Strong-test-password-123');
      assert.equal(session.account.accountType, accountType);
      assert.equal(store.getSession(session.token)?.kind, 'user');
    }
  });

  it('activates invited administrators only after a one-time token and strong password are supplied', async () => {
    const store = new AccountStore(join(testDirectory, 'admin-invite'));
    await store.init();
    const invitation = await store.inviteAdministrator({ firstName: 'Admin', lastName: 'Two', email: 'admin-two@example.test' });
    assert.equal(invitation.account.isAdmin, true);
    assert.equal(invitation.account.status, 'pending-verification');
    await assert.rejects(store.completeAdminInvitation(invitation.invitationToken, 'too-short'), /16 and 128/);

    const completed = await store.completeAdminInvitation(invitation.invitationToken, 'Strong-admin-password-123');
    assert.equal(completed.account.status, 'approved');
    assert.equal(store.getSession(completed.token)?.kind, 'admin');
    assert.equal(store.listAdministrators().length, 1);
    await assert.rejects(store.completeAdminInvitation(invitation.invitationToken, 'Strong-admin-password-123'), /invalid or expired/);
    await assert.rejects(store.deleteAdministrator(completed.account.id, completed.account.id), /own administrator/);
    await assert.rejects(store.deleteAdministrator(completed.account.id), /last active administrator/);
  });

  it('persists validated dashboard preferences across account-store reloads', async () => {
    const directory = join(testDirectory, 'dashboard-preferences');
    const store = new AccountStore(directory);
    await store.init();
    const registered = await store.register({
      firstName: 'Preference', lastName: 'Tester', email: 'preferences@example.test', phone: '2125550100',
      usageCase: 'Testing saved dashboard preferences.', accountType: 'news', password: 'Strong-test-password-123'
    });
    const saved = await store.setDashboardPreferences(registered.account.id, {
      boroughs: ['Queens', 'invalid'], audience: 'news', agency: 'NYPD', sortMode: 'newest', view: 'live',
      liveCategories: ['newsworthy', 'breaking', 'unknown']
    });
    assert.deepEqual(saved, {
      boroughs: ['Queens'], audience: 'news', agency: 'NYPD', sortMode: 'newest', view: 'live',
      liveCategories: ['newsworthy', 'breaking']
    });

    const reloaded = new AccountStore(directory);
    await reloaded.init();
    assert.deepEqual(reloaded.listAccounts()[0]?.dashboardPreferences, saved);
  });

  it('limits accounts to ten webhook destinations and excludes suspended or secret endpoints from public views', async () => {
    const store = new AccountStore(join(testDirectory, 'account-webhooks'));
    await store.init();
    const registered = await store.register({
      firstName: 'Webhook', lastName: 'Tester', email: 'webhook-account@example.test', phone: '2125550100',
      usageCase: 'Testing account webhook management.', accountType: 'buff', password: 'Strong-test-password-123'
    });
    const verified = await store.verifyEmail(registered.verificationToken);
    await store.updateAccount(verified.id, { status: 'approved' });
    const endpoints = Array.from({ length: 10 }, (_, index) => `https://discord.com/api/webhooks/123456789012345678/${String(index).padStart(24, 'a')}`);
    for (const [index, url] of endpoints.entries()) {
      await store.addAccountWebhook(verified.id, { id: index.toString(16).padStart(32, '0'), name: `Target ${index}`, url, platform: 'discord', boroughs: ['Brooklyn'] });
    }
    await assert.rejects(store.addAccountWebhook(verified.id, { id: 'f'.repeat(32), name: 'Over limit', url: endpoints[0]!, platform: 'discord', boroughs: 'all' }), /at most 10/);
    assert.equal(store.listWebhookTargets('Brooklyn', 'buff').length, 10);
    assert.equal(store.listWebhookTargets('Queens', 'buff').length, 0);
    assert.equal(await store.setWebhookSuspended(verified.id, '0'.repeat(32), true), true);
    assert.equal(store.listWebhookTargets('Brooklyn', 'buff').length, 9);
    await store.setWebhookAccessSuspended(verified.id, true);
    assert.equal(store.listWebhookTargets('Brooklyn', 'buff').length, 0);
    await assert.rejects(store.addAccountWebhook(verified.id, { id: 'e'.repeat(32), name: 'Blocked', url: endpoints[0]!, platform: 'discord', boroughs: 'all' }), /access is suspended/);
    const publicAccount = store.listAccounts().find((account) => account.id === verified.id)!;
    assert.equal(publicAccount.webhookAccessSuspended, true);
    assert.equal(JSON.stringify(publicAccount).includes('abcdefghijklmnopqrst'), false);
    assert.equal('url' in publicAccount.webhooks[0]!, false);
  });
});