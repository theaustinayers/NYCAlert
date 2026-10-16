import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
          username: `tester_${accountType}`,
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
    await assert.rejects(store.completeAdminInvitation(invitation.invitationToken, 'too-short', 'short_password'), /16 and 128/);

    const completed = await store.completeAdminInvitation(invitation.invitationToken, 'Strong-admin-password-123', 'reviewer_two');
    assert.equal(completed.account.status, 'approved');
    assert.equal(completed.account.username, 'reviewer_two');
    assert.equal('firstName' in completed.account, false);
    assert.equal(store.getSession(completed.token)?.kind, 'admin');
    assert.equal(store.listAdministrators().length, 1);
    await assert.rejects(store.completeAdminInvitation(invitation.invitationToken, 'Strong-admin-password-123', 'reviewer_three'), /invalid or expired/);
    await assert.rejects(store.deleteAdministrator(completed.account.id, completed.account.id), /own administrator/);
    await assert.rejects(store.deleteAdministrator(completed.account.id), /last active administrator/);
  });

  it('reserves an optional admin-invite username and prevents changing it during activation', async () => {
    const store = new AccountStore(join(testDirectory, 'admin-invite-username'));
    await store.init();
    const invitation = await store.inviteAdministrator({
      firstName: 'Staff', lastName: 'Member', email: 'staff-handle@example.test', username: 'Staff_Handle', role: 'reviewer'
    });
    assert.equal(invitation.account.username, 'Staff_Handle');
    await assert.rejects(store.inviteAdministrator({
      firstName: 'Other', lastName: 'Staff', email: 'other-staff@example.test', username: 'staff_handle'
    }), /already taken/);
    await assert.rejects(store.completeAdminInvitation(invitation.invitationToken, 'Strong-admin-password-123', 'different_handle'), /assigned by the administrator/);
    const completed = await store.completeAdminInvitation(invitation.invitationToken, 'Strong-admin-password-123');
    assert.equal(completed.account.username, 'Staff_Handle');
    assert.equal(completed.account.adminRole, 'reviewer');
  });

  it('persists validated dashboard preferences across account-store reloads', async () => {
    const directory = join(testDirectory, 'dashboard-preferences');
    const store = new AccountStore(directory);
    await store.init();
    const registered = await store.register({
      firstName: 'Preference', lastName: 'Tester', email: 'preferences@example.test', phone: '2125550100',
      username: 'preference_tester',
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
      username: 'webhook_tester',
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

  it('keeps legal names out of user-facing account/session data and enforces unique editable usernames', async () => {
    const store = new AccountStore(join(testDirectory, 'private-usernames'));
    await store.init();
    const first = await store.register({ username: 'Public_Handle', firstName: 'Private', lastName: 'Person', email: 'private-name@example.test', phone: '2125550100', usageCase: 'Testing public username privacy.', accountType: 'news', password: 'Strong-test-password-123' });
    assert.equal(first.account.username, 'Public_Handle');
    assert.equal('firstName' in first.account, false);
    assert.equal('lastName' in first.account, false);
    await assert.rejects(store.register({ username: 'public_handle', firstName: 'Another', lastName: 'Person', email: 'another-private@example.test', phone: '2125550100', usageCase: 'Testing duplicate username protection.', accountType: 'buff', password: 'Strong-test-password-123' }), /already taken/);
    await assert.rejects(store.register({ username: 'not valid', firstName: 'Another', lastName: 'Person', email: 'invalid-handle@example.test', phone: '2125550100', usageCase: 'Testing invalid username protection.', accountType: 'buff', password: 'Strong-test-password-123' }), /Username must be/);
    const verified = await store.verifyEmail(first.verificationToken);
    await store.updateAccount(verified.id, { status: 'approved' });
    const session = await store.login(verified.email, 'Strong-test-password-123');
    assert.equal(session.account.username, 'Public_Handle');
    assert.equal('firstName' in session.account, false);
    assert.equal('lastName' in session.account, false);
    assert.equal(await store.updateUsername(verified.id, 'new_public'), 'new_public');
    const second = await store.register({ username: 'second_user', firstName: 'Second', lastName: 'Person', email: 'second-private@example.test', phone: '2125550100', usageCase: 'Testing unique account usernames.', accountType: 'buff', password: 'Strong-test-password-123' });
    await assert.rejects(store.updateUsername(second.account.id, 'new_public'), /already taken/);
    const privateAdminView = store.listAdminAccounts().find((account) => account.id === verified.id)!;
    assert.equal(privateAdminView.firstName, 'Private');
    assert.equal(privateAdminView.lastName, 'Person');
    assert.equal(privateAdminView.username, 'new_public');
  });

  it('assigns existing accounts a stable generated username without deriving it from their legal name', async () => {
    const directory = join(testDirectory, 'legacy-usernames');
    const id = '0123456789abcdef0123456789abcdef';
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'accounts.json'), JSON.stringify([{
      id, firstName: 'Private', lastName: 'LegacyName', email: 'legacy@example.test', phone: '', usageCase: '', accountType: 'news',
      status: 'approved', emailVerifiedAt: new Date().toISOString(), createdAt: new Date().toISOString(), passwordSalt: 'salt', passwordHash: 'hash', webhooks: []
    }]));
    const store = new AccountStore(directory);
    await store.init();
    const account = store.listAccounts()[0]!;
    assert.equal(account.username, 'member_01234567');
    assert.doesNotMatch(account.username, /private|legacyname/i);
    assert.equal('firstName' in account, false);
  });
});