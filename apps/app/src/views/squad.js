// The squad room — /squad. Absorbs squad.html into the shell.
//
// Pick the eleven by tapping (a placement always trades places — the pure
// rules live in sheetOps.js), set the shape, board the tactics, save the
// sheet. The server's applyTeamSheet stays the gate: a refused save names
// the reason, a stale saved sheet is reported rather than hidden.
//
// Nothing reaches the server until SAVE — a manager can try an eleven
// without committing to it. While there are unsaved changes the view holds
// the shell's door (router leave guard) and the browser's (beforeunload).
import { html, pick } from '../ui.js';
import { mountSignIn } from './signin.js';
import { pickerSections, placePlayer } from './sheetOps.js';

/**
 * @param {HTMLElement} el
 * @param {{ auth: any, router: any, deps: any }} ctx
 * @returns {{ dispose(): void }}
 */
export function mountSquad(el, { auth, router, deps }) {
  const { playerCard, createPlayerDetail, FORMATIONS, prettyFormation, slotsFor, outOfPosition,
    TACTIC_GROUPS, TACTIC_CHOICES, PRESETS } = deps;

  let sheet = null;          // the working copy — server untouched until SAVE
  let byId = new Map();
  let colors;
  let source = 'generated';
  let selected = null;
  let dirty = false;
  let detail = null;
  let disposed = false;

  const setDirty = (v) => {
    dirty = v;
    router.setLeaveGuard(dirty
      ? () => window.confirm('You have unsaved changes on the team sheet — leave the squad room?')
      : null);
  };
  const onBeforeUnload = (e) => { if (dirty) e.preventDefault(); };
  window.addEventListener('beforeunload', onBeforeUnload);

  // ---- the three states of the door --------------------------------------
  function renderGate() {
    if (auth.state.status === 'signed_in') { boot(); return; }
    if (auth.state.status === 'entering') {
      html(el, `
        <div class="room-shell">
          <section class="panel roomcard"><h2 class="label">The eleven</h2>
            <div class="room-skel"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>
          </section>
        </div>`);
      return;
    }
    html(el, `
      <div class="roomgate">
        <section class="panel roomcard roomgate-card">
          <span class="label green">Squad room</span>
          <h1 class="display">The room opens when you sign in.</h1>
          <p class="muted">Your eleven, your shape, your briefing — saved to your account,
            worn at the next kick-off.</p>
          <div id="gateSignin"></div>
        </section>
      </div>`);
    mountSignIn(pick(el, 'gateSignin'), { auth, compact: true });
  }

  // ---- the room ----------------------------------------------------------
  let booted = false;
  async function boot() {
    if (booted) return;
    booted = true;
    html(el, `
      <div class="room-shell">
        <p class="err" id="topErr" role="alert"></p>
        <section class="room">
          <div class="panel roomcard">
            <h2 class="label">The eleven</h2>
            <div class="formbar" id="formbar"></div>
            <div class="roompitch" id="pitch" aria-label="Your lineup on the pitch">
              <div class="halfway"></div><div class="centre"></div>
            </div>
            <p class="muted room-hint" id="pitchHint"></p>
          </div>
          <div class="panel roomcard">
            <h2 class="label">Squad</h2>
            <div id="squadList"></div>
          </div>
        </section>
        <section class="panel roomcard">
          <h2 class="label">Tactics</h2>
          <p class="muted room-hint" style="margin-top:-4px">The same orders you can shout mid-match — the board and the touchline never disagree.</p>
          <div class="presets" id="presets"></div>
          <div class="choices" id="choices"></div>
          <div class="groups" id="groups"></div>
        </section>
        <div class="savebar">
          <span class="savebar-status" id="status">Pick your eleven and set your shape.</span>
          <button class="btn-quiet btn-sm" id="resetBtn">Reset</button>
          <button class="btn-primary" id="saveBtn">Save team sheet</button>
        </div>
      </div>`);

    detail = createPlayerDetail({
      onRename: async (player, name) => {
        const res = await auth.api('/squad', { method: 'POST', body: { players: [{ playerId: player.playerId, name }] } });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error ?? 'rename failed');
        await load();
      },
    });

    pick(el, 'saveBtn').addEventListener('click', save);
    pick(el, 'resetBtn').addEventListener('click', reset);
    await load();
  }

  function setStatus(text, kind = '') {
    const s = pick(el, 'status');
    if (!s) return;
    s.textContent = text;
    s.className = `savebar-status ${kind}`;
  }
  const markDirty = () => { setDirty(true); setStatus('Unsaved changes — save to take them into your next match.'); };

  async function load() {
    let sheetRes, squadRes;
    try {
      [sheetRes, squadRes] = await Promise.all([auth.api('/sheet'), auth.api('/squad')]);
    } catch {
      pick(el, 'topErr').textContent = 'The lobby is out of reach — your squad will load when the signal returns.';
      return;
    }
    if (disposed) return;
    if (!sheetRes.ok || !squadRes.ok) {
      // a 401 also lands here; the poll notices and the gate re-renders
      pick(el, 'topErr').textContent = 'Your squad did not load. It retries the next time you open the room.';
      return;
    }
    const sheetView = await sheetRes.json();
    const squad = await squadRes.json();
    byId = new Map(squad.players.map((p) => [p.playerId, p]));
    colors = squad.colors ?? undefined;
    source = squad.source ?? 'generated';
    sheet = {
      version: 1,
      lineup: [...sheetView.sheet.lineup],
      bench: [...sheetView.sheet.bench],
      formation: sheetView.sheet.formation ?? '442',
      tactics: { ...(sheetView.sheet.tactics ?? {}) },
    };
    pick(el, 'topErr').textContent = sheetView.issue
      ? `Your saved sheet is out of date: ${sheetView.issue}. Fix it and save again — until then your squad plays in its own order.`
      : '';
    setStatus(sheetView.saved
      ? 'This is the team sheet your next match starts with.'
      : 'No sheet saved yet — this is what your squad plays today.');
    setDirty(false);
    renderAll();
  }

  function renderAll() {
    renderFormbar(); renderPitch(); renderSquadList(); renderTactics();
  }

  // ---- formation + pitch -------------------------------------------------
  function renderFormbar() {
    const bar = pick(el, 'formbar');
    bar.replaceChildren();
    const label = document.createElement('span');
    label.className = 'muted';
    label.textContent = 'Formation';
    bar.appendChild(label);
    for (const f of FORMATIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn-quiet btn-sm${sheet.formation === f ? ' on' : ''}`;
      b.textContent = prettyFormation(f);
      b.setAttribute('aria-pressed', String(sheet.formation === f));
      b.onclick = () => { sheet.formation = f; markDirty(); renderAll(); };
      bar.appendChild(b);
    }
  }

  function renderPitch() {
    const pitch = pick(el, 'pitch');
    pitch.replaceChildren();
    const half = document.createElement('div'); half.className = 'halfway';
    const circle = document.createElement('div'); circle.className = 'centre';
    pitch.append(half, circle);

    slotsFor(sheet.formation).forEach((slot, i) => {
      const id = sheet.lineup[i];
      const player = byId.get(id);
      const wrap = document.createElement('div');
      wrap.className = 'slot';
      wrap.style.left = `${slot.x}%`;
      wrap.style.bottom = `${slot.y}%`;
      if (selected) wrap.classList.add('target');

      if (player) {
        wrap.appendChild(playerCard(player, colors, { onOpen: () => onSlotTap(i) }));
        if (outOfPosition(player.role, slot.role)) {
          wrap.classList.add('oop');
          const lab = document.createElement('div');
          lab.className = 'slotLabel';
          lab.textContent = `playing ${slot.role}`;
          wrap.appendChild(lab);
        }
      } else {
        const empty = document.createElement('button');
        empty.type = 'button';
        empty.className = 'pcard slot-empty';
        empty.textContent = slot.role;
        empty.onclick = () => onSlotTap(i);
        wrap.appendChild(empty);
      }
      pitch.appendChild(wrap);
    });

    pick(el, 'pitchHint').textContent = selected
      ? `${byId.get(selected)?.name ?? 'Player'} is picked up — tap a position to place him.`
      : 'Tap a player in your squad, then tap a position to place him. Tap a shirt to read his numbers.';
  }

  function onSlotTap(slotIndex) {
    if (!selected) {
      const p = byId.get(sheet.lineup[slotIndex]);
      if (p) detail.open(p, { colors, source });
      return;
    }
    sheet = placePlayer(sheet, slotIndex, selected);
    selected = null;
    markDirty();
    renderAll();
  }

  // ---- the squad list ----------------------------------------------------
  function renderSquadList() {
    const list = pick(el, 'squadList');
    list.replaceChildren();
    const { onBench, rest } = pickerSections(sheet, new Set(byId.keys()));

    const section = (label, ids) => {
      if (!ids.length) return;
      const h = document.createElement('div');
      h.className = 'sublabel label';
      h.textContent = label;
      list.appendChild(h);
      for (const id of ids) {
        const p = byId.get(id);
        if (!p) continue;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `listrow${selected === id ? ' sel' : ''}`;
        const n = document.createElement('span'); n.className = 'n'; n.textContent = `${p.shirtNumber}`;
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name;
        const rl = document.createElement('span'); rl.className = 'rl'; rl.textContent = p.role;
        const ov = document.createElement('span'); ov.className = 'ov'; ov.textContent = `${p.overall ?? ''}`;
        row.append(n, nm, rl, ov);
        row.setAttribute('aria-pressed', String(selected === id));
        row.onclick = () => { selected = selected === id ? null : id; renderAll(); };
        list.appendChild(row);
      }
    };
    section('On the bench', onBench);
    section('Not in the squad', rest);
    if (!onBench.length && !rest.length) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.textContent = 'Every player you own is in the eleven.';
      list.appendChild(none);
    }
  }

  // ---- tactics -----------------------------------------------------------
  function renderTactics() {
    const presets = pick(el, 'presets');
    presets.replaceChildren();
    for (const preset of PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-quiet btn-sm';
      b.textContent = preset.label;
      b.title = 'The same orders you can shout mid-match';
      b.onclick = () => { Object.assign(sheet.tactics, preset.patch); markDirty(); renderTactics(); };
      presets.appendChild(b);
    }

    const choices = pick(el, 'choices');
    choices.replaceChildren();
    for (const choice of TACTIC_CHOICES) {
      const wrap = document.createElement('div');
      wrap.className = 'choice';
      const lab = document.createElement('span');
      lab.className = 'label';
      lab.textContent = choice.label;
      const opts = document.createElement('div');
      opts.className = 'opts';
      for (const option of choice.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn-quiet btn-sm${sheet.tactics[choice.key] === option ? ' on' : ''}`;
        b.textContent = option;
        b.setAttribute('aria-pressed', String(sheet.tactics[choice.key] === option));
        b.onclick = () => { sheet.tactics[choice.key] = option; markDirty(); renderTactics(); };
        opts.appendChild(b);
      }
      wrap.append(lab, opts);
      choices.appendChild(wrap);
    }

    const groups = pick(el, 'groups');
    groups.replaceChildren();
    for (const group of TACTIC_GROUPS) {
      const g = document.createElement('div');
      g.className = 'grp';
      const h = document.createElement('h3');
      h.textContent = group.label;
      g.appendChild(h);
      for (const field of group.fields) {
        const set = sheet.tactics[field.key] !== undefined;
        const value = set ? sheet.tactics[field.key] : 0.5;
        const fld = document.createElement('div');
        fld.className = 'fld';
        const top = document.createElement('div');
        top.className = 'top';
        const name = document.createElement('span'); name.textContent = field.label;
        const val = document.createElement('span');
        val.className = 'val';
        val.textContent = set ? `${Math.round(value * 100)}` : 'default';
        top.append(name, val);
        const input = document.createElement('input');
        input.type = 'range'; input.min = '0'; input.max = '100'; input.step = '5';
        input.value = `${Math.round(value * 100)}`;
        input.setAttribute('aria-label', `${group.label} — ${field.label}`);
        input.oninput = () => {
          sheet.tactics[field.key] = Number(input.value) / 100;
          val.textContent = input.value;
          markDirty();
        };
        const ends = document.createElement('div');
        ends.className = 'ends';
        const lo = document.createElement('span'); lo.textContent = field.low;
        const hi = document.createElement('span'); hi.textContent = field.high;
        ends.append(lo, hi);
        fld.append(top, input, ends);
        g.appendChild(fld);
      }
      groups.appendChild(g);
    }
  }

  // ---- save / reset ------------------------------------------------------
  async function save() {
    pick(el, 'topErr').textContent = '';
    setStatus('Saving…');
    try {
      const res = await auth.api('/sheet', { method: 'PUT', body: sheet });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(out.error ?? 'That team sheet was refused.', 'bad');
        return;
      }
      setDirty(false);
      setStatus('Saved — your next match starts exactly like this.', 'ok');
    } catch (err) {
      setStatus(`Could not reach the lobby: ${err.message ?? err}`, 'bad');
    }
  }

  async function reset() {
    setStatus('Clearing…');
    try { await auth.api('/sheet', { method: 'DELETE' }); } catch { /* load() reports */ }
    selected = null;
    await load();
    setStatus('Back to your squad’s own order.', 'ok');
  }

  // ---- wiring ------------------------------------------------------------
  const onAuth = () => {
    if (auth.state.status === 'signed_in' && !booted) renderGate();
    if (auth.state.status === 'signed_out' && booted) {
      booted = false;
      detail?.destroy();
      detail = null;
      setDirty(false);
      renderGate();
    }
  };
  auth.on('change', onAuth);
  renderGate();

  return {
    dispose() {
      disposed = true;
      auth.off('change', onAuth);
      window.removeEventListener('beforeunload', onBeforeUnload);
      router.setLeaveGuard(null);
      detail?.destroy();
    },
  };
}
