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
}
