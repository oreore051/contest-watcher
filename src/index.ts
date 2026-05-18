import "dotenv/config";
import { Client } from "@notionhq/client";
import * as linkareer from "./linkareer.js";
import * as wevity from "./wevity.js";
import * as campuspick from "./campuspick.js";
import * as yutopia from "./yutopia.js";
import { enhance as geminiEnhance } from "./gemini.js";
import {
  upsertContest,
  syncRecommended,
  syncScheduleEntry,
  cleanupSchedule,
  scheduleTitleOf,
  fetchExistingUrls,
  isLikelyContest,
} from "./notion-write.js";
import type { Contest } from "./types.js";
import { scoreContest, isRecommended, RECOMMEND_THRESHOLD } from "./scoring.js";

interface Candidate {
  source: string;
  externalId: string;
  url: string;
  title: string;
  fetchDetail: () => Promise<Contest>;
}

async function collectCandidates(pages: number): Promise<Candidate[]> {
  const cands: Candidate[] = [];

  // 링커리어 — 키워드 필터, 페이지 1..pages
  let lkCount = 0;
  for (let p = 1; p <= pages; p++) {
    const { items } = await linkareer.fetchList(p);
    if (items.length === 0) break;
    for (const it of items) {
      if (!linkareer.isVideoContest(it.title)) continue;
      cands.push({
        source: "링커리어",
        externalId: it.id,
        url: linkareer.buildActivityUrl(it.id),
        title: it.title,
        fetchDetail: () => linkareer.fetchDetail(it.id),
      });
      lkCount++;
    }
  }
  console.log(`[링커리어] 영상 키워드 통과: ${lkCount}건 (page 1~${pages})`);

  // 위비티 — 영상/UCC 카테고리 이미 필터됨
  let wvCount = 0;
  for (let p = 1; p <= pages; p++) {
    const { items } = await wevity.fetchList(p);
    if (items.length === 0) break;
    for (const it of items) {
      cands.push({
        source: "위비티",
        externalId: it.ix,
        url: it.url,
        title: it.title,
        fetchDetail: () => wevity.fetchDetail(it.ix),
      });
      wvCount++;
    }
  }
  console.log(`[위비티] 영상/UCC 카테고리: ${wvCount}건 (page 1~${pages})`);

  // 캠퍼스픽 — 키워드 필터 (24개 최신만, page 인자 무시)
  let cpCount = 0;
  const { items: cpItems } = await campuspick.fetchList();
  for (const it of cpItems) {
    if (!campuspick.isVideoContest(it.title)) continue;
    cands.push({
      source: "캠퍼스픽",
      externalId: it.id,
      url: it.url,
      title: it.title,
      fetchDetail: () => campuspick.fetchDetail(it.id),
    });
    cpCount++;
  }
  console.log(`[캠퍼스픽] 영상 키워드 통과: ${cpCount}건 (최신 24)`);

  // 유토피아 — 카테고리 160 + 키워드 "영상" 직접 URL (서버 필터됨)
  let yuCount = 0;
  const { items: yuItems } = await yutopia.fetchList();
  for (const it of yuItems) {
    cands.push({
      source: "유토피아",
      externalId: it.id,
      url: it.url,
      title: it.title,
      fetchDetail: () => yutopia.fetchDetail(it.id),
    });
    yuCount++;
  }
  console.log(`[유토피아] 카테고리+키워드 통과: ${yuCount}건`);

  return cands;
}

/**
 * recommended DB에서 ⭐관심=true 페이지 → "일정" DB로 sync.
 * 매 cron 끝에 호출. 체크 해제된 건 일정에서 제거.
 */
async function syncScheduleFromInterests(notion: Client, recDbId: string, scheduleDbId: string) {
  const currentTitles = new Set<string>();
  let added = 0;
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: recDbId,
      filter: {
        and: [
          { property: "⭐관심", checkbox: { equals: true } },
          { property: "마감일", date: { is_not_empty: true } },
        ],
      },
      start_cursor: cursor,
      page_size: 100,
    });
    for (const p of res.results) {
      if (p.in_trash || p.archived) continue;
      const props = p.properties;
      const contest: Contest = {
        source: (props["소스"]?.select?.name as any) ?? "링커리어",
        externalId: "",
        url: props["원문"]?.url ?? "",
        title: props["제목"]?.title?.[0]?.plain_text ?? "",
        host: null,
        closeAt: props["마감일"]?.date?.start ?? null,
        prizeKRW: null,
        prizeScale: null,
        eligibility: null,
        topic: null,
        videoLength: null,
        submitMethod: null,
        postSelectionDuty: null,
        awardSamplesURL: null,
        status: "모집중",
        detailText: null,
        thumbnailURL: null,
      };
      if (!contest.title || !contest.closeAt) continue;
      const r = await syncScheduleEntry(notion, scheduleDbId, contest);
      if (r.created) added++;
      currentTitles.add(scheduleTitleOf(contest));
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  const removed = await cleanupSchedule(notion, scheduleDbId, currentTitles);
  return { added, removed, total: currentTitles.size };
}

async function main() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.DATABASE_ID;
  const recDbId = process.env.RECOMMENDED_DATABASE_ID;
  const scheduleDbId = process.env.SCHEDULE_DATABASE_ID;
  if (!token || !dbId) throw new Error("NOTION_TOKEN/DATABASE_ID 누락");
  const notion = new Client({ auth: token });

  const force = process.argv.includes("--force");
  const noGemini = process.argv.includes("--no-gemini");
  const limit = parseInt(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0", 10);
  const pages = parseInt(process.argv.find((a) => a.startsWith("--pages="))?.split("=")[1] ?? "3", 10);

  console.log("[notion] 기존 등록 URL 로드...");
  const existing = await fetchExistingUrls(notion, dbId);
  console.log(`  → ${existing.size}건\n`);

  const all = await collectCandidates(pages);
  console.log(`\n[전체] 후보 ${all.length}건`);

  const news = force ? all : all.filter((c) => !existing.has(c.url));
  const skipped = all.length - news.length;
  if (skipped > 0) console.log(`  → 이미 등록 ${skipped}건 스킵${force ? " (--force 무시)" : ""}`);

  const targets = limit > 0 ? news.slice(0, limit) : news;
  if (limit > 0 && news.length > limit) console.log(`  → --limit ${limit} 적용, ${news.length - limit}건 보류`);
  console.log(`  → 처리 대상: ${targets.length}건\n`);

  let created = 0;
  let updated = 0;
  let recommended = 0;
  let skipped_nonContest = 0;
  let skipped_nonVideo = 0;
  let failed = 0;
  for (const cand of targets) {
    try {
      console.log(`[${cand.source}] ${cand.externalId} ${cand.title.slice(0, 50)}`);
      let contest = await cand.fetchDetail();
      console.log(`  host=${contest.host} / close=${contest.closeAt} / prize=${contest.prizeKRW} / topic=${contest.topic}`);

      // 시상 정보 없으면 1차 비공모전 가능성 → 스킵
      if (!isLikelyContest(contest)) {
        skipped_nonContest++;
        console.log(`  → ⏭️  스킵 (시상 정보 없음)`);
        continue;
      }

      // Gemini 보강 + 영상 공모전 여부 판정
      if (!noGemini) {
        const result = await geminiEnhance(contest);
        if (result.usedLLM) {
          contest = result.contest;
          if (!result.isVideoContest) {
            skipped_nonVideo++;
            console.log(`  → ⏭️  스킵 (Gemini: ${result.reasoning})`);
            continue;
          } else {
            console.log(`  ✨ Gemini OK: ${result.reasoning}`);
          }
        }
      }

      const r = await upsertContest(notion, dbId, contest);
      if (r.created) created++;
      else updated++;
      console.log(`  → raw ${r.created ? "created" : "updated"}`);

      // 추천 점수 계산 + recommended DB sync
      if (recDbId) {
        const score = scoreContest(contest);
        if (isRecommended(score)) {
          const rr = await syncRecommended(notion, recDbId, contest, score);
          recommended++;
          console.log(`  → ⭐ recommended ${score.total}점 ${rr.created ? "created" : "updated"}: ${score.reasons.slice(0, 3).join(" · ")}`);
        } else {
          console.log(`  → 추천 X (${score.total}점)`);
        }
      }
    } catch (e: any) {
      failed++;
      console.error(`  ❌ ${e.message ?? e}`);
    }
  }
  console.log(
    `\n✅ 완료 — created ${created} / updated ${updated} / ⭐ recommended ${recommended} / 비공모전 ${skipped_nonContest} / 비영상 ${skipped_nonVideo} / failed ${failed}`,
  );

  // ⭐관심 체크된 공모전 → "일정" DB로 sync
  if (recDbId && scheduleDbId) {
    console.log(`\n[일정] ⭐관심 → 일정 DB sync...`);
    const s = await syncScheduleFromInterests(notion, recDbId, scheduleDbId);
    console.log(`  → 일정 ${s.total}건 (신규 ${s.added} · 제거 ${s.removed})`);
  }
}

main().catch((err) => {
  console.error("❌", err.body ?? err.message ?? err);
  process.exit(1);
});
