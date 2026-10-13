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
});