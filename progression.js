// Simple growth system (deliberately self-contained, so it can be tuned or removed).
//
// - Kills give points: goblins small 0.5, mid 1, large 1.5; zombies 0.5. Points are saved at
//   once and carry over between runs; one stat level costs 1 point.
// - After death the player spends points on health / attack / defence / stamina, then picks
//   "이어서 하기" (keep everything, next run uses the new stats) or "처음부터 시작" (wipe stats
//   and points). Stats apply when the next run starts.
// - Current stats are shown top right.
//
// To tune: change POINTS and STATS below.
// To remove: delete this file, then delete the lines tagged [progression] in main.js.
// main.js falls back to "click to restart" without it.

const KEY = "ethra.progression.v1";
const POINTS = { small: 0.5, mid: 1, large: 1.5, zombie: 0.5 };
const STATS = {
  hp: { label: "체력", effect: (n) => `최대 체력 +${10 * n}` },
  atk: { label: "공격력", effect: (n) => `피해 +${4 * n}` },
  def: { label: "방어력", effect: (n) => `받는 피해 -${Math.round((1 - defenceMul(n)) * 100)}%` },
  sta: { label: "지구력", effect: (n) => `최대 지구력 +${8 * n}` },
};
function defenceMul(n) { return Math.max(0.4, 1 - 0.04 * n); }
const fmt = (p) => (Number.isInteger(p) ? `${p}` : p.toFixed(1));   // half points show as 2.5

function load() {
  const empty = { points: 0, hp: 0, atk: 0, def: 0, sta: 0 };
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

#spend { margin: 28px auto 0; width: min(420px, calc(100vw - 32px)); opacity: 0; transition: opacity 0.8s ease-out 2.2s;
  color: #f1ead8; font: 14px "Pretendard", system-ui, sans-serif; text-align: left; }
#death.show #spend { opacity: 1; }
#spend .head { display: flex; justify-content: space-between; margin-bottom: 10px; color: rgba(241, 234, 216, 0.75); }
#spend .head b { color: #ffd479; font-weight: 600; }
#spend .stat { display: grid; grid-template-columns: 64px 1fr auto; align-items: center; gap: 12px;
  padding: 8px 12px; margin-bottom: 6px; background: rgba(241, 234, 216, 0.06); border-radius: 6px; }
#spend .stat .eff { color: rgba(241, 234, 216, 0.6); font-size: 12px; }
#spend .stat .ctl { display: flex; align-items: center; gap: 8px; }
#spend .stat .lv { min-width: 22px; text-align: center; font-weight: 600; }
#spend button { font: 600 13px "Pretendard", system-ui, sans-serif; color: #f1ead8; cursor: pointer;
  background: rgba(241, 234, 216, 0.08); border: 1px solid rgba(241, 234, 216, 0.3); border-radius: 5px; }
#spend button:hover:not(:disabled) { border-color: #ffd479; }
#spend button:disabled { opacity: 0.3; cursor: default; }
#spend .ctl button { width: 26px; height: 26px; padding: 0; }
#spend .actions { display: flex; gap: 10px; margin-top: 16px; }
#spend .actions button { flex: 1; padding: 10px; }
#spend .actions .go { background: #ffd479; color: #1b2130; border-color: #ffd479; }
#spend .actions .wipe.confirm { background: #a3201b; border-color: #a3201b; }
`;

export const progression = {
  data: load(),
  runGain: 0,                     // points earned in this run

  // called once at start: puts saved stats into the combat numbers
  apply(combat, hero) {
    const d = this.data;
    hero.maxHp = 100 + 10 * d.hp;
    hero.hp = hero.lag = hero.maxHp;
    const hpBar = document.getElementById("hpBar");          // the health bar grows with the stat
    if (hpBar) hpBar.style.width = `${300 * hero.maxHp / 100}px`;
    combat.heroDmg += 4 * d.atk;
    combat.damageTaken = defenceMul(d.def);
    combat.regen += 2 * d.sta;
    hero.maxSt = 100 + 8 * d.sta;
    hero.st = hero.maxSt;
    const stBar = document.getElementById("stBar");          // the stamina bar grows with the stat
    if (stBar) stBar.style.width = `${240 * hero.maxSt / 100}px`;
    this.mountHud();
  },

  onKill(kind) {
    const n = POINTS[kind] ?? 0;
    this.data.points = Math.round((this.data.points + n) * 2) / 2;
    this.runGain = Math.round((this.runGain + n) * 2) / 2;
    save(this.data);
    this.renderHud();
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
      `<div class="row pts"><span>포인트</span><b>${fmt(d.points)}${this.runGain ? ` <span class="gain">(+${fmt(this.runGain)})</span>` : ""}</b></div>`;
  },

  // called on death: replaces "click to restart" with the spend screen
  onDeath(deathEl) {
    const msg = deathEl.querySelector(".msg");
    msg.querySelector("p")?.remove();
    const box = document.createElement("div");
    box.id = "spend";
    msg.append(box);
    const pending = { hp: 0, atk: 0, def: 0, sta: 0 };
    let free = this.data.points;
    let wipeArmed = false;

    const render = () => {
      box.innerHTML = `
        <div class="head"><span>이번 판 획득 <b>+${fmt(this.runGain)}</b></span><span>남은 포인트 <b>${fmt(free)}</b></span></div>
        ${Object.entries(STATS).map(([k, s]) => {
          const lv = this.data[k] + pending[k];
          return `<div class="stat" data-k="${k}">
            <span>${s.label}</span>
            <span class="eff">${s.effect(lv)}</span>
            <span class="ctl"><button data-d="-1" ${pending[k] ? "" : "disabled"}>−</button>
              <span class="lv">${lv}</span><button data-d="1" ${free >= 1 ? "" : "disabled"}>+</button></span>
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
      } else if (b.classList.contains("go")) {                // keep stats, spend points, next run
        for (const k in pending) this.data[k] += pending[k];
        this.data.points = free;
        save(this.data);
        location.reload();
        return;
      } else if (b.classList.contains("wipe")) {              // two clicks: wipe stats and points
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
