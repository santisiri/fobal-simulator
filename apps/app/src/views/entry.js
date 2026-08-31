// The entry — what a signed-out visitor with no club sees at /.
// Left: the promise. Right: the doors in (sign in, or found a club).
import { html, pick } from '../ui.js';
import { mountSignIn, newHereCard } from './signin.js';

/**
 * @param {HTMLElement} el
 * @param {{ auth: any, router: any }} ctx
 */
export function mountEntry(el, { auth, router }) {
  html(el, `
    <div class="bezel entry-bezel"><div class="bezel-in entry">
      <section class="entry-hero">
        <div class="entry-brandline">
          <span class="entry-mark" aria-hidden="true">▚</span>
          <span class="entry-name">FOBAL<span>.ai</span></span>
          <span class="label">Season 01 · Founding era</span>
        </div>
        <h1 class="display entry-kick">Bring your squad.<br><span>Say the word.</span></h1>
        <p class="entry-sub">Live football between two managers. Your players are yours
          — on-chain. Your tactics are spoken out loud, and eleven shirts obey.</p>
        <div class="entry-cta">
          <a class="btn-primary btn-lg" data-nav="/onboarding" href="#" id="foundBtn">Found your club</a>
          <a class="btn-quiet btn-lg" data-nav="/lobby" href="#" id="watchBtn">Enter the lobby</a>
        </div>
        <div class="entry-words label" aria-hidden="true">
          <span class="purple">Own</span><i>·</i><span class="green">Trade</span><i>·</i><span>Compete</span>
        </div>
      </section>
      <aside class="entry-door">
        <div id="entrySignin"></div>
        <div id="entryNewHere"></div>
      </aside>
    </div></div>`);

  pick(el, 'foundBtn').setAttribute('href', router.href('/onboarding'));
  pick(el, 'watchBtn').setAttribute('href', router.href('/lobby'));
  html(pick(el, 'entryNewHere'), newHereCard(router.href('/onboarding')));
  mountSignIn(pick(el, 'entrySignin'), { auth });
}
