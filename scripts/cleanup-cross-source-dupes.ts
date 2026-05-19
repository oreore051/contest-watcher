/**
 * cross-source 중복 정리.
 * 같은 (제목 + 마감일) 그룹에서 소스 우선순위(링커리어 > 위비티 > 캠퍼스픽 > 유토피아)로 canonical 선정,
 * 나머지는 휴지통.
 * trash 전에 비-canonical의 ⭐관심·메모를 canonical로 머지 (사용자 데이터 보존).
 *
 * 사용:
 *   npx tsx scripts/cleanup-cross-source-dupes.ts --dry      # 보고만
 *   npx tsx scripts/cleanup-cross-source-dupes.ts --apply    # 실제 정리
 */
import "dotenv/config";
import { Client } from "@notionhq/client";

const PRIORITY: Record<string, number> = {
  링커리어: 1,
  위비티: 2,
  캠퍼스픽: 3,
  유토피아: 4,
};

const notion = new Client({ auth: process.env.NOTION_TOKEN! });

interface Page {
  id: string;
  title: string;
  url: string;
  source: string;
  closeAt: string;
  starred: boolean;
  memo: string;
  created: string;
}

async function loadAll(dbId: string): Promise<Page[]> {
  const out: Page[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({ database_id: dbId, start_cursor: cursor, page_size: 100 });
    for (const p of res.results) {
      if (p.in_trash || p.archived) continue;
      out.push({
        id: p.id,
        title: p.properties?.["제목"]?.title?.[0]?.plain_text ?? "",
        url: p.properties?.["원문"]?.url ?? "",
        source: p.properties?.["소스"]?.select?.name ?? "",
        closeAt: p.properties?.["마감일"]?.date?.start ?? "",
        starred: !!p.properties?.["⭐관심"]?.checkbox,
        memo: p.properties?.["메모"]?.rich_text?.[0]?.plain_text ?? "",
        created: p.created_time,
      });
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  return out;
}

async function cleanupDb(name: string, dbId: string, apply: boolean) {
  console.log(`\n=== ${name} ===`);
  const pages = await loadAll(dbId);
  const groups = new Map<string, Page[]>();
  for (const p of pages) {
    if (!p.title || !p.closeAt) continue;
    const k = `${p.title}|${p.closeAt}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  const dupes = [...groups.values()].filter((v) => v.length > 1);
  console.log(`총 ${pages.length}건, 중복 그룹 ${dupes.length}개`);

  let trashed = 0;
  let merged = 0;
  for (const group of dupes) {
    // canonical = 가장 높은 우선순위 (PRIORITY 작은 값)
    const sorted = [...group].sort((a, b) => {
      const pa = PRIORITY[a.source] ?? 99;
      const pb = PRIORITY[b.source] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.created.localeCompare(b.created); // 동률은 먼저
    });
    const canonical = sorted[0];
    const losers = sorted.slice(1);
    console.log(`\n[${canonical.title}]`);
    console.log(`  ✅ keep: ${canonical.source.padEnd(6)} ${canonical.url} (id=${canonical.id.slice(0,8)})`);

    // 머지: loser의 ⭐관심·메모가 있고 canonical에 없으면 옮김
    const losersStarred = losers.filter((l) => l.starred && !canonical.starred);
    const losersMemo = losers.find((l) => l.memo && !canonical.memo);
    const mergeProps: any = {};
    if (losersStarred.length) {
      mergeProps["⭐관심"] = { checkbox: true };
      console.log(`  🔄 merge ⭐관심 from ${losersStarred.map((l) => l.source).join(", ")}`);
      merged++;
    }
    if (losersMemo) {
      mergeProps["메모"] = { rich_text: [{ text: { content: losersMemo.memo } }] };
      console.log(`  🔄 merge 메모 from ${losersMemo.source}: "${losersMemo.memo.slice(0,40)}"`);
      merged++;
    }
    if (apply && Object.keys(mergeProps).length > 0) {
      await notion.pages.update({ page_id: canonical.id, properties: mergeProps });
    }

    for (const loser of losers) {
      console.log(`  🗑️  trash: ${loser.source.padEnd(6)} ${loser.url} (id=${loser.id.slice(0,8)})`);
      if (apply) {
        await notion.pages.update({ page_id: loser.id, in_trash: true } as any);
      }
      trashed++;
    }
  }
  console.log(`\n${apply ? "✅" : "[DRY]"} ${name}: ${trashed}건 휴지통, ${merged}건 머지`);
}

const apply = process.argv.includes("--apply");
const dry = process.argv.includes("--dry") || !apply;
console.log(dry ? "🔍 DRY RUN (--apply 없음)" : "⚙️  APPLY MODE");

await cleanupDb("raw_database", process.env.DATABASE_ID!, apply);
await cleanupDb("recommended_database", process.env.RECOMMENDED_DATABASE_ID!, apply);
