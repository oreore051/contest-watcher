import "dotenv/config";
import { Client } from "@notionhq/client";

async function main() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.DATABASE_ID;

  if (!token || !dbId) {
    console.error("[contest-watcher] NOTION_TOKEN 또는 DATABASE_ID 누락 — .env 확인");
    process.exit(1);
  }

  const notion = new Client({ auth: token });

  const me = await notion.users.me({});
  console.log("[contest-watcher] bot:", me.name, `(${me.id})`);

  const db = await notion.databases.retrieve({ database_id: dbId });
  const title = "title" in db && Array.isArray(db.title)
    ? db.title.map((t: any) => t.plain_text).join("")
    : "(no title)";
  console.log("[contest-watcher] db  :", title);
  console.log("[contest-watcher] ✅ Notion 연결 OK");
}

main().catch((err) => {
  console.error("[contest-watcher] ❌", err.body ?? err.message ?? err);
  process.exit(1);
});
