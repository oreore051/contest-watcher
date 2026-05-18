import { Client } from "@notionhq/client";
import type { Contest } from "./types.js";

const truncate = (s: string | null, max = 1900): string => {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

const rt = (s: string | null) =>
  s ? { rich_text: [{ text: { content: truncate(s) } }] } : { rich_text: [] };

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

export async function upsertContest(notion: Client, dbId: string, c: Contest): Promise<{ id: string; created: boolean }> {
  const properties = contestToProperties(c);
  const existing = await findByUrl(notion, dbId, c.url);
  if (existing) {
    await notion.pages.update({ page_id: existing, properties });
    return { id: existing, created: false };
  }
  const children = buildBodyChildren(c.detailText);
  const page = await notion.pages.create({
    parent: { database_id: dbId },
    properties,
    children: children as any,
  });
  return { id: page.id, created: true };
}
