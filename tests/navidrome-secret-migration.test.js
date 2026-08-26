'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decryptChromiumV10, reencryptLegacyNavidromeSecrets } = require('../desktop/navidrome-secret-migration');

function encryptV10(text, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), nonce, body, cipher.getAuthTag()]);
}

test('portable migration decrypts Chromium v10 and immediately re-encrypts for the new profile', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-secret-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const protectedKey = crypto.randomBytes(48);
  const localState = path.join(directory, 'Local State');
  const sourceSecrets = path.join(directory, 'source', 'server-secrets.json');
  const targetSecrets = path.join(directory, 'target', 'server-secrets.json');
  fs.mkdirSync(path.dirname(sourceSecrets), { recursive: true });
  fs.writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), protectedKey]).toString('base64') } }));
  fs.writeFileSync(sourceSecrets, JSON.stringify({ schema: 1, values: { server: encryptV10('private-password', key).toString('base64') } }));

  const count = await reencryptLegacyNavidromeSecrets({
    sourceLocalStatePath: localState,
    sourceSecretPath: sourceSecrets,
    targetSecretPath: targetSecrets,
    unprotectKey: async (payload) => {
      assert.deepEqual(payload, protectedKey);
      return Buffer.from(key);
    },
    encryptString: (value) => Buffer.from(`new-profile:${value}`, 'utf8'),
  });

  assert.equal(count, 1);
  const migrated = JSON.parse(fs.readFileSync(targetSecrets, 'utf8'));
  assert.equal(Buffer.from(migrated.values.server, 'base64').toString('utf8'), 'new-profile:private-password');
  assert.doesNotMatch(fs.readFileSync(targetSecrets, 'utf8'), /private-password/);
});

test('Chromium v10 authentication failure does not produce plaintext', () => {
  const key = crypto.randomBytes(32);
  const payload = encryptV10('secret', key);
  payload[payload.length - 1] ^= 1;
  assert.throws(() => decryptChromiumV10(payload, key));
});
