import "dotenv/config";
import { Client } from "@notionhq/client";
import * as linkareer from "./linkareer.js";
import * as wevity from "./wevity.js";
import { upsertContest, fetchExistingUrls, isLikelyContest } from "./notion-write.js";
import type { Contest } from "./types.js";

interface Candidate {
  source: string;
  externalId: string;
  url: string;
  title: string;
  fetchDetail: () => Promise<Contest>;
}

async function collectCandidates(): Promise<Candidate[]> {
  const cands: Candidate[] = [];

  // 링커리어 — 키워드 필터
  const lk = await linkareer.fetchList(1);
  for (const it of lk.items) {
    if (!linkareer.isVideoContest(it.title)) continue;
    cands.push({
      source: "링커리어",
      externalId: it.id,
      url: linkareer.buildActivityUrl(it.id),
      title: it.title,
      fetchDetail: () => linkareer.fetchDetail(it.id),
    });
  }
  console.log(`[링커리어] 영상 키워드 통과: ${cands.filter((c) => c.source === "링커리어").length}건`);

  // 위비티 — 영상/UCC 카테고리로 이미 필터됨
  const wv = await wevity.fetchList(1);
  for (const it of wv.items) {
    cands.push({
      source: "위비티",
      externalId: it.ix,
      url: it.url,
      title: it.title,
      fetchDetail: () => wevity.fetchDetail(it.ix),
    });
  }
  console.log(`[위비티] 영상/UCC 카테고리: ${cands.filter((c) => c.source === "위비티").length}건`);

  return cands;
}

async function main() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.DATABASE_ID;
  if (!token || !dbId) throw new Error("NOTION_TOKEN/DATABASE_ID 누락");
  const notion = new Client({ auth: token });

  const force = process.argv.includes("--force");
  const limit = parseInt(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0", 10);

  console.log("[notion] 기존 등록 URL 로드...");
  const existing = await fetchExistingUrls(notion, dbId);
  console.log(`  → ${existing.size}건\n`);

  const all = await collectCandidates();
  console.log(`\n[전체] 후보 ${all.length}건`);

  const news = force ? all : all.filter((c) => !existing.has(c.url));
  const skipped = all.length - news.length;
  if (skipped > 0) console.log(`  → 이미 등록 ${skipped}건 스킵${force ? " (--force 무시)" : ""}`);

  const targets = limit > 0 ? news.slice(0, limit) : news;
  if (limit > 0 && news.length > limit) console.log(`  → --limit ${limit} 적용, ${news.length - limit}건 보류`);
  console.log(`  → 처리 대상: ${targets.length}건\n`);

  let created = 0;
  let updated = 0;
  let skipped_nonContest = 0;
  let failed = 0;
  for (const cand of targets) {
    try {
      console.log(`[${cand.source}] ${cand.externalId} ${cand.title.slice(0, 50)}`);
      const contest = await cand.fetchDetail();
      console.log(`  host=${contest.host} / close=${contest.closeAt} / prize=${contest.prizeKRW} / topic=${contest.topic}`);
      if (!isLikelyContest(contest)) {
        skipped_nonContest++;
        console.log(`  → ⏭️  스킵 (시상 정보 없음 — 봉사·교육·모집 가능성)`);
        continue;
      }
      const r = await upsertContest(notion, dbId, contest);
      if (r.created) created++;
      else updated++;
      console.log(`  → ${r.created ? "created" : "updated"}`);
    } catch (e: any) {
      failed++;
      console.error(`  ❌ ${e.message ?? e}`);
    }
  }
  console.log(`\n✅ 완료 — created ${created} / updated ${updated} / 비공모전 스킵 ${skipped_nonContest} / failed ${failed}`);
}

main().catch((err) => {
  console.error("❌", err.body ?? err.message ?? err);
  process.exit(1);
});
