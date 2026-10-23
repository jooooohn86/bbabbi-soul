// Simple growth system (deliberately self-contained, so it can be tuned or removed).
//
// - Kills give points: goblins small 0.5, mid 1, large 1.5; zombies 0.5, medusa 1. Points earned in
//   a run are only CARRIED: on death they are left where the hero fell (a glowing stain, data.stain).
//   Touching it in the next run banks them; dying again first loses them (Souls-style recovery).
//   Banked points carry over between runs; one stat level costs 1 point. The boss reward is banked
//   at once.
// - After death the player spends points on health / attack / defence / stamina / mind and
//   unlocks special skills (skills.js), then picks "이어서 하기" (keep everything, next run uses
//   the new stats) or "처음부터 시작" (wipe stats, skills and points). Stats apply when the next
//   run starts.
// - Current stats are shown top right; the equipped skill is remembered between runs.
//
// To tune: change POINTS and STATS below (skill prices live in skills.js).
// To remove: delete this file, then delete its import line in main.js (tagged [progression]).
// main.js falls back to "click to restart" without it, and no skill can be used.
import { SKILLS, MIND_BASE, unlockCost } from "./skills.js";

const KEY = "ethra.progression.v1";
const POINTS = { small: 0.5, mid: 1, large: 1.5, zombie: 0.5, medusa: 1 };
const STATS = {
  hp: { label: "체력", effect: (n) => `최대 체력 +${10 * n}` },
  atk: { label: "공격력", effect: (n) => `피해 +${4 * n}` },
  def: { label: "방어력", effect: (n) => `받는 피해 -${Math.round((1 - defenceMul(n)) * 100)}%` },
  sta: { label: "지구력", effect: (n) => `최대 지구력 +${8 * n}` },
  mind: { label: "정신력", effect: (n) => `최대 정신력 +${10 * n}` },
};
function defenceMul(n) { return Math.max(0.4, 1 - 0.04 * n); }
const fmt = (p) => (Number.isInteger(p) ? `${p}` : p.toFixed(1));   // half points show as 2.5

function load() {
  // carried: points earned this run (lost to the stain on death); stain: {x, y, z, points} or null;
  // deaths: total deaths; queenDefeated: the boss is gone for good once beaten
  const empty = { points: 0, hp: 0, atk: 0, def: 0, sta: 0, mind: 0, skills: [], equipped: null,
    carried: 0, stain: null, deaths: 0, queenDefeated: false };
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return empty;                 // storage blocked (private window etc.): play without saving
  }
}
function save(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* not saved; the run still works */ }
}

const css = `
#growth { position: fixed; right: 16px; top: 96px; padding: 10px 14px; border-radius: 6px; min-width: 150px;
  background: rgba(20, 24, 34, 0.72); color: #f1ead8; font: 13px/1.7 "Pretendard", system-ui, sans-serif;
  pointer-events: none; }
#growth h3 { margin: 0 0 2px; font-size: 12px; font-weight: 600; color: #ffd479; letter-spacing: 0.04em; }
#growth .row { display: flex; justify-content: space-between; gap: 16px; }
#growth .row b { font-weight: 600; }
#growth .pts { margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(241, 234, 216, 0.15); color: #ffd479; }
#growth .gain { color: #8fd18a; }

#spend { margin: 24px auto 0; width: min(460px, calc(100vw - 32px)); opacity: 0; transition: opacity 0.8s ease-out 2.2s;
  color: #f1ead8; font: 14px "Pretendard", system-ui, sans-serif; text-align: left;
  max-height: calc(100vh - 260px); overflow-y: auto; }
#death.show #spend { opacity: 1; }
#spend .head { display: flex; justify-content: space-between; margin-bottom: 10px; color: rgba(241, 234, 216, 0.75); }
#spend .head b { color: #ffd479; font-weight: 600; }
#spend .note { margin: -4px 0 10px; color: rgba(241, 234, 216, 0.55); font-size: 12px; line-height: 1.6; }
#spend .note:empty { display: none; }
#spend h4 { margin: 14px 0 6px; font-size: 12px; font-weight: 600; color: rgba(241, 234, 216, 0.6); letter-spacing: 0.04em; }
#spend .stat, #spend .skill { display: grid; grid-template-columns: 64px 1fr auto; align-items: center; gap: 12px;
  padding: 8px 12px; margin-bottom: 6px; background: rgba(241, 234, 216, 0.06); border-radius: 6px; }
#spend .skill { grid-template-columns: 22px 1fr auto; }
#spend .skill .num { color: #8fb8ff; font-weight: 600; }
#spend .skill .name { font-weight: 600; }
#spend .skill .eff, #spend .stat .eff { color: rgba(241, 234, 216, 0.6); font-size: 12px; }
#spend .skill.owned .tag { color: #8fd18a; font-size: 12px; font-weight: 600; }
#spend .stat .ctl { display: flex; align-items: center; gap: 8px; }
#spend .stat .lv { min-width: 22px; text-align: center; font-weight: 600; }
#spend button { font: 600 13px "Pretendard", system-ui, sans-serif; color: #f1ead8; cursor: pointer;
  background: rgba(241, 234, 216, 0.08); border: 1px solid rgba(241, 234, 216, 0.3); border-radius: 5px; }
#spend button:hover:not(:disabled) { border-color: #ffd479; }
#spend button:disabled { opacity: 0.3; cursor: default; }
#spend .ctl button { width: 26px; height: 26px; padding: 0; }
#spend .skill button { padding: 5px 10px; white-space: nowrap; }
#spend .skill button.pending { background: #8fb8ff; color: #1b2130; border-color: #8fb8ff; }
#spend .actions { display: flex; gap: 10px; margin-top: 16px; }
#spend .actions button { flex: 1; padding: 10px; }
#spend .actions .go { background: #ffd479; color: #1b2130; border-color: #ffd479; }
#spend .actions .wipe.confirm { background: #a3201b; border-color: #a3201b; }
`;

export const progression = {
  data: load(),
  // points earned in this run (carried, at risk). A page refresh mid-run keeps carrying them.
  get runGain() { return this.data.carried; },
  lostStain: 0,                   // points of an old stain lost by dying before reaching it (death screen)

  // called once at start: puts saved stats into the combat numbers
  apply(combat, hero) {
    const d = this.data;
    hero.maxHp = 100 + 10 * d.hp;
    hero.hp = hero.lag = hero.maxHp;
    combat.heroDmg += 4 * d.atk;
    combat.damageTaken = defenceMul(d.def);
    combat.regen += 2 * d.sta;
    hero.maxSt = 100 + 8 * d.sta;
    hero.st = hero.maxSt;
    hero.maxMind = MIND_BASE + 10 * d.mind;
    hero.mind = hero.maxMind;
    // the bars grow with their stats
    const widen = (id, base, value, full) => {
      const el = document.getElementById(id);
      if (el) el.style.width = `${base * value / full}px`;
    };
    widen("hpBar", 300, hero.maxHp, 100);
    widen("stBar", 240, hero.maxSt, 100);
    widen("mpBar", 240, hero.maxMind, MIND_BASE);
    this.mountHud();
  },

  // skills the player has unlocked, in SKILLS order
  unlocked() {
    return SKILLS.filter((s) => this.data.skills.includes(s.id)).map((s) => s.id);
  },
  equipped() {
    const own = this.unlocked();
    return own.includes(this.data.equipped) ? this.data.equipped : own[0] ?? null;
  },
  equip(id) {
    if (!this.data.skills.includes(id)) return false;
    this.data.equipped = id;
    save(this.data);
    return true;
  },

  onKill(kind) {
    const n = POINTS[kind] ?? 0;
    this.data.carried = Math.round((this.data.carried + n) * 2) / 2;
    save(this.data);
    this.renderHud();
  },

  // the boss reward is banked at once (losing it to a stain would be too cruel)
  onBossKill(points) {
    this.data.points = Math.round((this.data.points + points) * 2) / 2;
    this.data.queenDefeated = true;
    save(this.data);
    this.renderHud();
  },

  // the points left where the hero last fell, or null
  stain() { return this.data.stain; },
  // touching the stain banks its points; returns how many
  recoverStain() {
    const s = this.data.stain;
    if (!s) return 0;
    this.data.points = Math.round((this.data.points + s.points) * 2) / 2;
    this.data.stain = null;
    save(this.data);
    this.renderHud();
    return s.points;
  },
  // on death: the carried points stay where the hero fell; an unrecovered older stain is lost
  dropStain(pos) {
    this.lostStain = this.data.stain?.points ?? 0;
    const n = this.data.carried;
    this.data.stain = n > 0 ? { x: pos.x, y: pos.y, z: pos.z, points: n } : null;
    this.data.dropped = n;
    this.data.carried = 0;
    this.data.deaths++;
    save(this.data);
  },

  mountHud() {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    this.hud = document.createElement("div");
    this.hud.id = "growth";
    document.body.append(this.hud);
    this.renderHud();
  },

  renderHud() {
    const d = this.data;
    this.hud.innerHTML = `<h3>성장</h3>` +
      Object.entries(STATS).map(([k, s]) => `<div class="row"><span>${s.label}</span><b>${d[k]}</b></div>`).join("") +
      `<div class="row pts"><span>포인트</span><b>${fmt(d.points)}</b></div>` +
      (d.carried ? `<div class="row gain"><span>소지</span><b>+${fmt(d.carried)}</b></div>` : "");
  },

  // called on death: replaces "click to restart" with the spend screen
  onDeath(deathEl) {
    const msg = deathEl.querySelector(".msg");
    msg.querySelector("p")?.remove();
    const box = document.createElement("div");
    box.id = "spend";
    msg.append(box);
    const pending = { hp: 0, atk: 0, def: 0, sta: 0, mind: 0 };
    const unlocking = [];                                    // skills picked this time, in order
    let free = this.data.points;
    let wipeArmed = false;
    const owned = () => this.data.skills.length + unlocking.length;

    const render = () => {
      box.innerHTML = `
        <div class="head"><span>${this.data.dropped ? `쓰러진 자리에 <b>+${fmt(this.data.dropped)}</b> 남김` : "남긴 포인트 없음"}</span><span>남은 포인트 <b>${fmt(free)}</b></span></div>
        <div class="note">${this.data.dropped ? "다음 판에 쓰러진 자리의 빛에 닿으면 되찾습니다. 그 전에 또 쓰러지면 잃습니다." : ""}
          ${this.lostStain ? `<br>되찾지 못한 이전 흔적의 ${fmt(this.lostStain)} 포인트를 잃었습니다.` : ""}</div>
        ${Object.entries(STATS).map(([k, s]) => {
          const lv = this.data[k] + pending[k];
          return `<div class="stat" data-k="${k}">
            <span>${s.label}</span>
            <span class="eff">${s.effect(lv)}</span>
            <span class="ctl"><button data-d="-1" ${pending[k] ? "" : "disabled"}>−</button>
              <span class="lv">${lv}</span><button data-d="1" ${free >= 1 ? "" : "disabled"}>+</button></span>
          </div>`;
        }).join("")}
        <h4>특수 기술 해금 · 다음 해금 ${unlockCost(owned())} 포인트</h4>
        ${SKILLS.map((s, i) => {
          const have = this.data.skills.includes(s.id), picked = unlocking.includes(s.id);
          const right = have ? `<span class="tag">해금됨</span>`
            : picked ? `<button class="pending" data-unlock="${s.id}">해금 취소</button>`
            : `<button data-unlock="${s.id}" ${free >= unlockCost(owned()) ? "" : "disabled"}>해금 ${unlockCost(owned())}</button>`;
          return `<div class="skill ${have ? "owned" : ""}">
            <span class="num">${i + 1}</span>
            <span><span class="name">${s.name}</span><br><span class="eff">${s.desc}</span></span>
            ${right}
          </div>`;
        }).join("")}
        <div class="actions">
          <button class="go">이어서 하기</button>
          <button class="wipe ${wipeArmed ? "confirm" : ""}">${wipeArmed ? "정말 초기화할까요?" : "처음부터 시작"}</button>
        </div>`;
    };
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || b.disabled) return;
      e.stopPropagation();
      if (b.dataset.d) {                                      // + / − on a stat
        const k = b.closest(".stat").dataset.k, step = +b.dataset.d;
        pending[k] += step;
        free -= step;
      } else if (b.dataset.unlock) {                          // pick or un-pick a skill to unlock
        const id = b.dataset.unlock, at = unlocking.indexOf(id);
        if (at < 0) {
          free -= unlockCost(owned());
          unlocking.push(id);
        } else {
          // refund everything picked from here on (prices depend on order), keep the earlier ones
          for (let i = unlocking.length - 1; i >= at; i--) free += unlockCost(this.data.skills.length + i);
          unlocking.splice(at);
        }
      } else if (b.classList.contains("go")) {                // keep stats, spend points, next run
        for (const k in pending) this.data[k] += pending[k];
        this.data.skills.push(...unlocking);
        if (!this.data.equipped && this.data.skills.length) this.data.equipped = this.data.skills[0];
        this.data.points = free;
        save(this.data);
        location.reload();
        return;
      } else if (b.classList.contains("wipe")) {              // two clicks: wipe stats, skills and points
        if (!wipeArmed) { wipeArmed = true; }
        else {
          try { localStorage.removeItem(KEY); } catch { /* nothing saved anyway */ }
          location.reload();
          return;
        }
      }
      render();
    });
    render();
  },
};
