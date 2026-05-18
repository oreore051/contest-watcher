import { Client } from "@notionhq/client";
import type { Contest } from "./types.js";
import type { Score } from "./scoring.js";

const UNKNOWN = "표기 없음";

const truncate = (s: string | null, max = 1900): string => {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

// rich_text 필드용 — null/empty면 "표기 없음" 마킹 (사용자 가시성).
const rt = (s: string | null) => ({
  rich_text: [{ text: { content: truncate(s) || UNKNOWN } }],
});

export function contestToProperties(c: Contest): Record<string, any> {
  return {
    제목: { title: [{ text: { content: truncate(c.title, 200) } }] },
    주최: rt(c.host),
    소스: { select: { name: c.source } },
    마감일: c.closeAt ? { date: { start: c.closeAt } } : { date: null },
    상금: c.prizeKRW != null ? { number: c.prizeKRW } : { number: null },
    시상규모: rt(c.prizeScale),
    참가자격: rt(c.eligibility),
    주제: rt(c.topic),
    형식: rt(c.format),
    영상길이: rt(c.videoLength),
    제출방식: rt(c.submitMethod),
    "선정후 활동": rt(c.postSelectionDuty),
    수상작: c.awardSamplesURL ? { url: c.awardSamplesURL } : { url: null },
    원문: { url: c.url },
    상태: { select: { name: c.status } },
  };
}

/**
 * DB에 이미 등록된 모든 원문 URL을 한 번에 가져와서 Set으로 반환.
 * 매번 findByUrl 부르는 것보다 훨씬 효율적 (N+1 쿼리 방지).
 * 휴지통(in_trash)·archived 페이지는 제외.
 */
export async function fetchExistingUrls(notion: Client, dbId: string): Promise<Set<string>> {
  const urls = new Set<string>();
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: dbId,
      filter: { property: "원문", url: { is_not_empty: true } },
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of res.results) {
      if (page.in_trash || page.archived) continue;
      const url = page.properties?.["원문"]?.url;
      if (url) urls.add(url);
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  return urls;
}

const PARAGRAPH_MAX = 1900; // Notion rich_text content limit

function chunkParagraph(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += PARAGRAPH_MAX) {
    out.push(text.slice(i, i + PARAGRAPH_MAX));
  }
  return out;
}

/**
 * 본문 텍스트를 노션 paragraph 블록 배열로.
 * \n\n 단위로 단락 나누고, 단락 안에서 1900자 chunk로 분할.
 * 노션 페이지 children 최대 100개 제한 고려.
 */
function textToBlocks(text: string, maxBlocks = 90): any[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const blocks: any[] = [];
  for (const para of paragraphs) {
    if (blocks.length >= maxBlocks) break;
    for (const chunk of chunkParagraph(para)) {
      if (blocks.length >= maxBlocks) break;
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: chunk } }] },
      });
    }
  }
  return blocks;
}

function buildBodyChildren(detailText: string | null): any[] {
  if (!detailText) return [];
  const blocks = textToBlocks(detailText);
  if (blocks.length === 0) return [];
  return [
    {
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ text: { content: "📋 본문" } }] },
    },
    ...blocks,
  ];
}

const SCHEDULE_TITLE_PREFIX = "🎬 ";

/**
 * "일정" DB로 sync — recommended에서 ⭐관심 체크된 페이지의 마감일을 캘린더 일정으로.
 * 일정 DB 컬럼: 이름(title), 날짜(date)만 사용. 추가 컬럼 X.
 * Dedup: 제목 정확 매칭 (🎬 prefix + 공모전 제목).
 */
export async function syncScheduleEntry(
  notion: Client,
  scheduleDbId: string,
  c: Contest,
): Promise<{ id: string; created: boolean; skipped?: boolean }> {
  if (!c.closeAt) return { id: "", created: false, skipped: true };
  const title = SCHEDULE_TITLE_PREFIX + c.title;

  const res: any = await notion.databases.query({
    database_id: scheduleDbId,
    filter: { property: "이름", title: { equals: title } },
    page_size: 1,
  });
  const properties = {
    이름: { title: [{ text: { content: title.slice(0, 200) } }] },
    날짜: { date: { start: c.closeAt } },
  } as any;

  if (res.results[0]) {
    const id = res.results[0].id;
    await notion.pages.update({ page_id: id, properties });
    return { id, created: false };
  }
  const page = await notion.pages.create({
    parent: { database_id: scheduleDbId },
    properties,
    icon: emojiIcon("🎬"),
  });
  return { id: page.id, created: true };
}

/**
 * "일정" DB에서 더 이상 ⭐관심 아닌 공모전 일정을 정리(삭제).
 * 매번 cron에서: 현재 ⭐관심 set 만들고, 일정 DB의 🎬 prefix 항목 중 이 set에 없는 건 휴지통.
 */
export async function cleanupSchedule(
  notion: Client,
  scheduleDbId: string,
  currentTitles: Set<string>,
): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: scheduleDbId,
      filter: { property: "이름", title: { starts_with: SCHEDULE_TITLE_PREFIX } },
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of res.results) {
      if (page.in_trash || page.archived) continue;
      const t = page.properties?.["이름"]?.title?.[0]?.plain_text ?? "";
      if (!currentTitles.has(t)) {
        await notion.pages.update({ page_id: page.id, in_trash: true } as any);
        removed++;
      }
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  return removed;
}

export const scheduleTitleOf = (c: Contest) => SCHEDULE_TITLE_PREFIX + c.title;

export async function findByUrl(notion: Client, dbId: string, url: string): Promise<string | null> {
  const res = await notion.databases.query({
    database_id: dbId,
    filter: { property: "원문", url: { equals: url } },
    page_size: 1,
  });
  return res.results[0]?.id ?? null;
}

/**
 * 시상 정보가 전혀 없으면 (상금 null + 시상규모 빈값) 공모전 아닐 가능성 큼.
 * 봉사단 모집·교육 프로그램·서포터즈 등 차단.
 */
export function isLikelyContest(c: Contest): boolean {
  return c.prizeKRW != null || !!c.prizeScale;
}

/**
 * recommended_database로 동기화. 점수 ≥ 임계값 통과한 공모전만.
 * raw와 동일 URL이면 update, 아니면 create.
 */
function iconForScore(score: number): string {
  if (score >= 95) return "🏆";
  if (score >= 85) return "⭐";
  if (score >= 75) return "👍";
  return "📋";
}

export async function syncRecommended(
  notion: Client,
  recDbId: string,
  c: Contest,
  score: Score,
): Promise<{ id: string; created: boolean }> {
  const properties = contestToProperties(c);
  properties["추천 점수"] = { number: score.total };
  properties["추천 사유"] = {
    rich_text: [{ text: { content: score.reasons.join(" · ").slice(0, 1900) } }],
  };

  const cover = buildCover(c);
  const icon = emojiIcon(iconForScore(score.total));

  const existing = await findByUrl(notion, recDbId, c.url);
  if (existing) {
    await notion.pages.update({ page_id: existing, properties, cover, icon });
    return { id: existing, created: false };
  }
  const page = await notion.pages.create({
    parent: { database_id: recDbId },
    properties,
    cover,
    icon,
  });
  return { id: page.id, created: true };
}

function buildCover(c: Contest): any {
  if (!c.thumbnailURL) return undefined;
  // 노션이 못 가져오는 도메인이 있을 수 있어 https 만 통과
  if (!c.thumbnailURL.startsWith("https://")) return undefined;
  return { type: "external", external: { url: c.thumbnailURL } };
}

function emojiIcon(emoji: string): any {
  return { type: "emoji", emoji };
}

export async function upsertContest(notion: Client, dbId: string, c: Contest): Promise<{ id: string; created: boolean }> {
  const properties = contestToProperties(c);
  const cover = buildCover(c);
  const icon = emojiIcon("🎬");
  const existing = await findByUrl(notion, dbId, c.url);
  if (existing) {
    await notion.pages.update({ page_id: existing, properties, cover, icon });
    return { id: existing, created: false };
  }
  const children = buildBodyChildren(c.detailText);
  const page = await notion.pages.create({
    parent: { database_id: dbId },
    properties,
    cover,
    icon,
    children: children as any,
  });
  return { id: page.id, created: true };
}
