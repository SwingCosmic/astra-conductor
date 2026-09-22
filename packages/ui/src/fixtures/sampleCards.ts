export type QuotaWindow = {
  label: string;
  remainingPercent: number | null;
  used?: number;
  total?: number;
  resetLabel?: string;
};

export type QuotaGroup = {
  title: string | null;
  windows: QuotaWindow[];
};

export type QuotaExtra = {
  label: string;
  value: string;
};

export type SampleCard = {
  id: string;
  providerName: string;
  plan: string;
  accountLabel: string;
  statusLabel: string;
  updatedAt: string;
  groups: QuotaGroup[];
  extras: QuotaExtra[];
};

export const sampleCards: SampleCard[] = [
  {
    id: "antigravity",
    providerName: "Antigravity",
    plan: "Starter",
    accountLabel: "a•••@gmail.com",
    statusLabel: "已启用",
    updatedAt: "17:53",
    groups: [
      {
        title: "Gemini Models",
        windows: [
          { label: "5 Hour Quota", remainingPercent: 80, resetLabel: "6d 23h" },
          { label: "Weekly Quota", remainingPercent: 12, resetLabel: "6d 23h" },
        ],
      },
      {
        title: "Claude and GPT models",
        windows: [
          { label: "5 Hour Quota", remainingPercent: 100, resetLabel: "6d 23h" },
          { label: "Weekly Quota", remainingPercent: 4, resetLabel: "6d 23h" },
        ],
      },
    ],
    extras: [],
  },
  {
    id: "codex",
    providerName: "Codex",
    plan: "Plus",
    accountLabel: "swi•••@example.com",
    statusLabel: "已启用",
    updatedAt: "07:51",
    groups: [
      {
        title: null,
        windows: [
          { label: "5-hour", remainingPercent: 100, resetLabel: "4h 12m" },
          { label: "Weekly", remainingPercent: 65, resetLabel: "4d 6h" },
        ],
      },
    ],
    extras: [{ label: "Reset credits", value: "1" }],
  },
  {
    id: "grok-cli",
    providerName: "Grok Build",
    plan: "Grokpro",
    accountLabel: "swi•••@x.ai",
    statusLabel: "已启用",
    updatedAt: "18:02",
    groups: [
      {
        title: null,
        windows: [
          { label: "GrokChat", remainingPercent: 99, resetLabel: "2d 17h" },
          { label: "Grok Build", remainingPercent: 55, resetLabel: "2d 17h" },
          { label: "Weekly", remainingPercent: 54, resetLabel: "2d 17h" },
        ],
      },
    ],
    extras: [
      { label: "Extra Usage Credits", value: "US$0.00" },
      { label: "Auto Top-Up", value: "Unavailable" },
    ],
  },
  {
    id: "glm-cn",
    providerName: "glm-cn",
    plan: "Lite",
    accountLabel: "main",
    statusLabel: "已启用",
    updatedAt: "17:51",
    groups: [
      {
        title: null,
        windows: [
          {
            label: "5 Hours Quota",
            remainingPercent: 100,
            used: 0,
            total: 2000,
            resetLabel: "4h 50m",
          },
          {
            label: "Weekly Quota",
            remainingPercent: 75,
            used: 2563,
            total: 10000,
            resetLabel: "4d 17h",
          },
        ],
      },
    ],
    extras: [],
  },
];
