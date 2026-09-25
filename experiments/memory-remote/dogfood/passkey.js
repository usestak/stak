/*
 * Stack Memory passkey capability dogfood (SPIKE ONLY).
 *
 * Exercises the REAL WebAuthn PRF flow in the browser against a SYNTHETIC random
 * MMK, then proves the MMK can be recovered after discarding it locally. Reports
 * ONLY capability/state to the DOM. It NEVER prints key material (PRF output, MMK,
 * or wrapping key) to the DOM or the console.
 *
 * Mirrors the Node model in ../src: PRF output → HKDF(domain "stack-memory-passkey-v1")
 * → AES-GCM wrap of the MMK. Here enrollment + recovery happen entirely in the
 * browser; the CLI bridge is proven separately in ../src/bridge.test.ts.
 */

const enc = new TextEncoder();
// Stable PRF input salt — MUST be identical at enroll and recover to get the same
// PRF output from the same authenticator. Not secret.
const PRF_SALT = enc.encode('stack-memory-recovery-prf-input-v1');
const HKDF_SALT = enc.encode('stack-memory-passkey-hkdf-salt-v1');
const HKDF_INFO = enc.encode('stack-memory-passkey-v1');
const RP_ID = location.hostname; // "localhost" when served locally

// In-memory dogfood state. We keep only a HASH of the synthetic MMK and the wrapped
// blob — never the MMK bytes themselves after enrollment.
const state = {
  credentialId: /** @type {ArrayBuffer|null} */ (null),
  wrapped: /** @type {{iv: Uint8Array, ct: ArrayBuffer}|null} */ (null),
  originalMmkHashHex: /** @type {string|null} */ (null),
};

const $ = (id) => document.getElementById(id);
const log = (message) => {
  // Status messages only — never key material.
  $('log').textContent += `${message}\n`;
};
const setCell = (id, ok, text) => {
  const cell = $(id);
  cell.textContent = text;
  cell.className = `v ${ok ? 'ok' : 'no'}`;
};

const sha256Hex = async (bytes) => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const deriveKek = async (prfOutput) => {
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    prfOutput,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
    hkdfKey,
    256,
  );
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
};

const detect = async () => {
  const hasPasskey = typeof window.PublicKeyCredential === 'function';
  setCell('s-passkey', hasPasskey, hasPasskey ? 'supported' : 'not supported');
  if (!hasPasskey) return;

  try {
    const uvpaa =
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    setCell('s-platform', uvpaa, uvpaa ? 'available' : 'unavailable');
  } catch {
    setCell('s-platform', false, 'unknown');
  }

  // PRF advertised? getClientCapabilities is Chrome 133+/L3; key is "extension:prf".
  try {
    if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
      const caps = await PublicKeyCredential.getClientCapabilities();
      const advertised = caps['extension:prf'] === true;
      setCell(
        's-prf-adv',
        advertised,
        advertised ? 'advertised' : 'not advertised',
      );
    } else {
      setCell('s-prf-adv', false, 'API unavailable');
    }
  } catch {
    setCell('s-prf-adv', false, 'unknown');
  }
  log(
    'Detection complete. getClientCapabilities reports client support only; the',
  );
  log('ground truth is a real get() returning prf.results (step 3).');
};

const enroll = async () => {
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Stack Memory Dogfood', id: RP_ID },
        user: {
          id: userId,
          name: 'stack-dogfood',
          displayName: 'Stack Dogfood',
        },
        challenge,
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          userVerification: 'required',
          residentKey: 'preferred',
        },
        // Enable PRF. Per research, do NOT rely on create() returning results.
        extensions: { prf: {} },
      },
    });
    state.credentialId = cred.rawId;
    const ext = cred.getClientExtensionResults();
    const prfEnabled = ext?.prf?.enabled === true;
    setCell('s-cred', true, 'created');
    log(`Credential created. prf.enabled at create(): ${prfEnabled}`);

    // Obtain PRF output via authentication (the reliable path).
    const prfOutput = await getPrfOutput();
    if (!prfOutput) {
      setCell('s-prf-use', false, 'PRF unavailable');
      log(
        'PRF output not returned by get(). Passkey auth works, but PRF does not.',
      );
      log('Fallback: use a Recovery file instead of a passkey.');
      return;
    }
    setCell('s-prf-use', true, 'usable');

    // Wrap a SYNTHETIC random MMK, then discard the MMK bytes.
    const mmk = crypto.getRandomValues(new Uint8Array(32));
    state.originalMmkHashHex = await sha256Hex(mmk);
    const kek = await deriveKek(prfOutput);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, mmk);
    state.wrapped = { iv, ct };
    mmk.fill(0); // discard plaintext MMK
    prfOutput.fill(0);
    log('Synthetic MMK wrapped under passkey PRF. Plaintext MMK discarded.');
    log('Now click step 3 to recover it with a fresh authentication.');
  } catch (error) {
    setCell('s-cred', false, 'failed');
    log(`Enrollment failed: ${error?.name ?? 'Error'}`);
  }
};

const getPrfOutput = async () => {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: RP_ID,
      allowCredentials: state.credentialId
        ? [{ type: 'public-key', id: state.credentialId }]
        : [],
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  });
  const first = assertion.getClientExtensionResults()?.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
};

const recover = async () => {
  try {
    if (!state.wrapped || !state.originalMmkHashHex) {
      log('Nothing to recover — run step 2 first.');
      return;
    }
    const prfOutput = await getPrfOutput();
    if (!prfOutput) {
      setCell('s-recover', false, 'PRF unavailable');
      return;
    }
    const kek = await deriveKek(prfOutput);
    const recovered = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: state.wrapped.iv },
        kek,
        state.wrapped.ct,
      ),
    );
    const hex = await sha256Hex(recovered);
    recovered.fill(0);
    prfOutput.fill(0);
    const passed = hex === state.originalMmkHashHex;
    setCell('s-recover', passed, passed ? 'passed' : 'MISMATCH');
    log(
      passed
        ? 'MMK recovery PASSED (hash matched).'
        : 'MMK recovery FAILED (hash mismatch).',
    );
  } catch (error) {
    setCell('s-recover', false, 'failed');
    log(
      `Recovery failed: ${error?.name ?? 'Error'} (wrong PRF output or tamper).`,
    );
  }
};

$('btn-detect').addEventListener('click', detect);
$('btn-enroll').addEventListener('click', enroll);
$('btn-recover').addEventListener('click', recover);
