export type Source = "링커리어" | "위비티" | "캠퍼스픽" | "유토피아";

export interface Contest {
  source: Source;
  externalId: string;
  url: string;
  title: string;
  host: string | null;
  closeAt: string | null;
  prizeKRW: number | null;
  prizeScale: string | null;
  eligibility: string | null;
  topic: string | null;
  videoLength: string | null;
  submitMethod: string | null;
  postSelectionDuty: string | null;
  awardSamplesURL: string | null;
  status: "모집중" | "마감임박" | "마감";
  detailText: string | null;
  thumbnailURL: string | null;
}

export function deriveStatus(closeAt: string | null): "모집중" | "마감임박" | "마감" {
  if (!closeAt) return "모집중";
  const days = Math.ceil((Date.parse(closeAt) - Date.now()) / 86400000);
  if (days < 0) return "마감";
  if (days <= 7) return "마감임박";
  return "모집중";
}
