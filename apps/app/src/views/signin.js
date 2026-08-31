// ENTER THE CLUB — the one sign-in surface, mounted big on the entry page
// and compact on the club home rail. Owns its own inputs and step state, so
// the poll-driven re-renders around it never steal focus mid-type.
//
// Two equal doors, both already proven server-side:
//   email — /auth/request → code → /auth/verify (magic code)
//   wallet — /auth/wallet → personal_sign → /auth/wallet/verify (EIP-191,
//            no gas, no transaction; ENS shows only when verified)
import { esc, html, pick } from '../ui.js';

/**
 * @param {HTMLElement} el
 * @param {{ auth: any, compact?: boolean, ethereum?: any }} ctx
 */
export function mountSignIn(el, { auth, compact = false, ethereum }) {
  html(el, `
    <div class="signin${compact ? ' signin--compact' : ''}">
      <span class="label green">Enter the club</span>
      <form class="signin-email" id="emailForm" novalidate>
        <label class="label" for="siEmail">Email</label>
        <div class="signin-row">
          <input class="input" id="siEmail" type="email" inputmode="email" autocomplete="email"
                 placeholder="manager@club.com" required>
          <button class="btn-primary" id="siContinue" type="submit">Continue</button>
        </div>
        <div class="signin-code" id="siCodeRow" hidden>
          <label class="label" for="siCode">Login code</label>
          <div class="signin-row">
            <input class="input" id="siCode" inputmode="numeric" autocomplete="one-time-code" placeholder="the code from your email">
            <button class="btn-primary" id="siVerify" type="button">Enter</button>
          </div>
        </div>
      </form>
      <div class="signin-divider" aria-hidden="true"><span>equal door</span></div>
      <button class="btn-own signin-wallet" id="siWallet" type="button">
        Sign in with wallet
        <small>ENS shows when verified — never a raw address</small>
      </button>
      <p class="signin-err" id="siErr" role="alert"></p>
      <p class="signin-note" id="siNote"></p>
    </div>`);

  const emailInput = /** @type {HTMLInputElement} */ (pick(el, 'siEmail'));
  const codeInput = /** @type {HTMLInputElement} */ (pick(el, 'siCode'));
  const err = pick(el, 'siErr');
  const note = pick(el, 'siNote');
  const say = (line, isErr = false) => {
    err.textContent = isErr ? line : '';
    note.textContent = isErr ? '' : line;
  };

  pick(el, 'emailForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    // second submit (Enter in the code field) verifies
    if (!pick(el, 'siCodeRow').hidden) return verify();
    const email = emailInput.value.trim();
    if (!email) return say('Your email opens the door — type it first.', true);
    say('');
    try {
      const out = await auth.emailRequest(email);
      pick(el, 'siCodeRow').hidden = false;
      pick(el, 'siContinue').hidden = true;
      if (out?.devCode) {
        codeInput.value = out.devCode;
        say('Dev mode — the code filled itself in.');
      } else {
        say('The code is in your inbox.');
      }
      codeInput.focus();
    } catch (e2) { say(friendly(e2), true); }
  });

  async function verify() {
    const email = emailInput.value.trim();
    const code = codeInput.value.trim();
    if (!code) return say('The code from your email goes here.', true);
    say('');
    try { await auth.emailVerify(email, code); }
    catch (e2) { say(friendly(e2), true); }
  }
  pick(el, 'siVerify').addEventListener('click', verify);

  pick(el, 'siWallet').addEventListener('click', async () => {
    say('');
    const provider = ethereum ?? /** @type {any} */ (globalThis).ethereum;
    if (!provider) return say('No wallet extension detected — install MetaMask, or take the email door.', true);
    say('Sign the message in your wallet — free, no gas, nothing on-chain.');
    try { await auth.walletSignIn(provider); say(''); }
    catch (e2) { say(friendly(e2), true); }
  });

  /** the calm surface; the console keeps the truth */
  function friendly(e) {
    const m = String(e?.message ?? e ?? '');
    if (/rejected|denied/i.test(m)) return 'You waved the wallet off — no harm done. Sign when ready.';
    if (/fetch|network|Failed to/i.test(m)) return 'The lobby is out of reach — check your connection and try again.';
    return m || 'That did not go through — try again.';
  }

  return { focus: () => emailInput.focus() };
}

/** the entry hero's right-hand door panel also offers the founding path */
export const newHereCard = (foundHref) => `
  <a class="doorcard" data-nav="/onboarding" href="${esc(foundHref)}">
    <span class="doorcard-ico" aria-hidden="true">◳</span>
    <span class="doorcard-body">
      <b>New here?</b>
      <small>Name your club, pick your kit, meet your first eleven</small>
    </span>
    <span class="doorcard-go" aria-hidden="true">→</span>
  </a>`;
