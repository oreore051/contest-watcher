import type { Contest } from "./types.js";

const TEAM_SIZE = 2; // LEEJAY 블로그 기준 친구와 2~3인 팀
export const RECOMMEND_THRESHOLD = 70;

const daysUntil = (iso: string | null): number => {
  if (!iso) return -999;
  return Math.ceil((Date.parse(iso) - Date.now()) / 86400000);
};

export interface Score {
  total: number;
  reasons: string[];
}

export function scoreContest(c: Contest): Score {
  let total = 0;
  const reasons: string[] = [];

  // 1. 마감 여유 (20)
  const days = daysUntil(c.closeAt);
  if (days < 0) {
    total += 0;
    reasons.push(`⏱️ 마감 지남 (${-days}일 전)`);
  } else if (days < 7) {
    total += 5;
    reasons.push(`⚠️ D-${days} 너무 임박`);
  } else if (days < 14) {
    total += 14;
    reasons.push(`⏰ D-${days} 빠듯`);
  } else if (days <= 60) {
    total += 20;
    reasons.push(`✅ D-${days} 적정`);
  } else {
    total += 12;
    reasons.push(`📅 D-${days} 여유 큼`);
  }

  // 2. 상금 1인분 환산 (20, 2인 팀 가정)
  const perPerson = c.prizeKRW ? c.prizeKRW / TEAM_SIZE : 0;
  if (perPerson >= 10_000_000) {
    total += 20;
    reasons.push(`💰 1인 ${Math.round(perPerson / 10000)}만원`);
  } else if (perPerson >= 1_000_000) {
    total += 20;
    reasons.push(`💰 1인 ${Math.round(perPerson / 10000)}만원 큼`);
  } else if (perPerson >= 300_000) {
    total += 17;
    reasons.push(`💰 1인 ${Math.round(perPerson / 10000)}만원 적정`);
  } else if (perPerson > 0) {
    total += 10;
    reasons.push(`⚠️ 1인 ${Math.round(perPerson / 10000)}만원 작음`);
  } else {
    total += 5;
    reasons.push(`❓ 상금 미상`);
  }

  // 3. 영상길이 (15)
  const vl = c.videoLength ?? "";
  if (vl && vl !== "표기 없음" && /[분초]/.test(vl)) {
    total += 15;
    reasons.push(`🎬 ${vl}`);
  } else {
    total += 7;
  }

  // 4. 참가자격 매치 (15)
  const elig = c.eligibility ?? "";
  if (/대학생|제한.?없음|일반|누구나|학생/.test(elig)) {
    total += 15;
  } else if (elig && elig !== "표기 없음") {
    total += 8;
    reasons.push(`⚠️ 자격 확인: ${elig.slice(0, 30)}`);
  } else {
    total += 10;
  }

  // 5. 교내 가점 (10)
  if (c.source === "유토피아") {
    total += 10;
    reasons.push(`🏫 영남대 교내`);
  } else {
    total += 5;
  }

  // 6. 주제 명확 (10)
  if (c.topic && c.topic !== "표기 없음") {
    total += 10;
  } else {
    total += 5;
  }

  // 7. 선정후 활동 부담 (10)
  const psd = c.postSelectionDuty ?? "";
  if (!psd || psd === "표기 없음") {
    total += 10;
  } else if (/멘토링|교육|의무\s*참여|행사/.test(psd)) {
    total += 4;
    reasons.push(`⚠️ 선정후 부담`);
  } else {
    total += 8;
  }

  return { total, reasons };
}

export function isRecommended(score: Score): boolean {
  return score.total >= RECOMMEND_THRESHOLD;
}
