const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function safeJson(filePath, fsImpl = fs) {
  return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
}

function atomicWriteJson(filePath, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fsImpl.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fsImpl.renameSync(temp, filePath);
}

function decryptChromiumV10(value, key) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (payload.length < 3 + 12 + 16 || payload.subarray(0, 3).toString('ascii') !== 'v10') {
    throw new Error('NAVIDROME_LEGACY_SECRET_FORMAT_UNSUPPORTED');
  }
  const nonce = payload.subarray(3, 15);
  const tag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(15, payload.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function unprotectDpapiCurrentUser(payload) {
  if (process.platform !== 'win32') return Promise.reject(new Error('NAVIDROME_DPAPI_UNAVAILABLE'));
  const command = [
    "[void][Reflection.Assembly]::LoadWithPartialName('System.Security');",
    '$encoded=[Console]::In.ReadToEnd().Trim();',
    '$cipher=[Convert]::FromBase64String($encoded);',
    '$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '[Console]::Out.Write([Convert]::ToBase64String($plain));',
  ].join('');
  return new Promise((resolve, reject) => {
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_error) { }
      finish(new Error('NAVIDROME_DPAPI_TIMEOUT'));
    }, 10000);
    child.on('error', () => finish(new Error('NAVIDROME_DPAPI_UNAVAILABLE')));
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        try { child.kill(); } catch (_error) { }
        finish(new Error('NAVIDROME_DPAPI_OUTPUT_INVALID'));
        return;
      }
      chunks.push(chunk);
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error('NAVIDROME_DPAPI_FAILED'));
      try {
        const value = Buffer.from(Buffer.concat(chunks).toString('ascii').trim(), 'base64');
        if (!value.length) throw new Error('NAVIDROME_DPAPI_OUTPUT_INVALID');
        finish(null, value);
      } catch (_error) {
        finish(new Error('NAVIDROME_DPAPI_OUTPUT_INVALID'));
      }
    });
    child.stdin.end(Buffer.from(payload).toString('base64'));
  });
}

async function reencryptLegacyNavidromeSecrets({
  sourceLocalStatePath,
  sourceSecretPath,
  targetSecretPath,
  encryptString,
  unprotectKey = unprotectDpapiCurrentUser,
  fsImpl = fs,
}) {
  if (typeof encryptString !== 'function') throw new Error('NAVIDROME_ENCRYPTION_UNAVAILABLE');
  const localState = safeJson(sourceLocalStatePath, fsImpl);
  const encodedKey = String(localState && localState.os_crypt && localState.os_crypt.encrypted_key || '');
  const protectedKey = Buffer.from(encodedKey, 'base64');
  if (protectedKey.length <= 5 || protectedKey.subarray(0, 5).toString('ascii') !== 'DPAPI') {
    throw new Error('NAVIDROME_DPAPI_KEY_INVALID');
  }
  const secrets = safeJson(sourceSecretPath, fsImpl);
  const values = secrets && secrets.values && typeof secrets.values === 'object' ? secrets.values : {};
  const key = await unprotectKey(protectedKey.subarray(5));
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('NAVIDROME_DPAPI_KEY_INVALID');
  const migrated = { schema: 1, values: {} };
  try {
    for (const [id, encoded] of Object.entries(values)) {
      const plaintext = decryptChromiumV10(Buffer.from(String(encoded || ''), 'base64'), key);
      try {
        migrated.values[id] = Buffer.from(encryptString(plaintext.toString('utf8'))).toString('base64');
      } finally {
        plaintext.fill(0);
      }
    }
    atomicWriteJson(targetSecretPath, migrated, fsImpl);
    return Object.keys(migrated.values).length;
  } finally {
    key.fill(0);
  }
}

module.exports = {
  decryptChromiumV10,
  reencryptLegacyNavidromeSecrets,
  unprotectDpapiCurrentUser,
};
