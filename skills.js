// Special skills: spent with mind (정신력), used with F, picked with the number keys, unlocked
// with points on the death screen.
//
// To add a skill:
//   1. add an entry here (its id, name and a one-line description);
//   2. add a handler with the same id to SKILL_ACTIONS in main.js (what it plays and what it hits);
//   3. if it needs a new hero motion, add the pose to blender/render_hero.py and re-render.
// The number key is its position in this list.

export const SKILLS = [
  { id: "spin", name: "회전베기", desc: "제자리에서 한 바퀴 돌며 주위의 적을 모두 벱니다" },
  { id: "pierce", name: "관통 찌르기", desc: "앞으로 돌진하며 경로의 적을 모두 꿰뚫습니다 (돌진 중 무적)" },
  { id: "shock", name: "충격파", desc: "땅을 내리쳐 주변 적에게 피해를 주고 멀리 밀쳐 냅니다" },
];

export const MIND_BASE = 100;                       // max mind before any 정신력 stat
export const SKILL_MIND_COST = MIND_BASE * 0.15;    // every skill costs 15% of the base mind
export const SKILL_DAMAGE = 1.5;                    // normal attack damage + 50%
export const SKILL_STAMINA = 0.5;                   // half of a normal attack's stamina

// unlock price: the first skill unlocked costs 20 points, each one after it 10 more
export function unlockCost(alreadyUnlocked) {
  return 20 + 10 * alreadyUnlocked;
}
