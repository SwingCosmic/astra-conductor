export interface RateCondition {
  meter?: string;
  above?: number;
  atLeast?: number;
  quality?: string;
  region?: string;
  timeZone?: string;
  weekdays?: number[];
  windows?: [string, string][];
  excludeCalendarRef?: string;
}

export interface ChargeLine {
  lineId: string;
  meter: string;
  per: { quantity: number; unit: string };
  amount: string | null;
  rounding?: { mode: "exact" | "ceil"; step?: number; scope?: "total" | "per-item" };
}

export type RateRule =
  | {
      ruleId: string;
      mode: "replace";
      when: RateCondition;
      setAmounts: Record<string, string | null>;
    }
  | {
      ruleId: string;
      mode: "graduated";
      applyTo?: "accountBillingCycle";
      lineId: string;
      bands: { upToInclusive: number | null; amount: string | null }[];
    };

export interface RateCard {
  rateCardId: string;
  revision: string;
  currency: string;
  chargeLines: ChargeLine[];
  overrides: RateRule[];
  entitlements: {
    meter: string;
    included: { quantity: number; unit: string };
    overagePolicy: "block" | "charge";
    reset?: { period: "account-billing-month"; timeZone: string };
  }[];
  effectiveFrom?: string;
  effectiveUntil?: string | null;
  source?: string | { kind: string; referenceUrl?: string; checkedAt?: string };
  scope?: {
    providerId: string;
    offeringId: string;
    operationId: string;
    upstreamModelId?: string;
    access?: "api" | "subscription";
    planId?: string;
    region?: string;
    protocolRouteId?: string;
  };
  subscriptionFee?: { amount: string; period: "month" | "year" };
}

export interface BillingWorkload {
  meters: Record<string, number>;
  time?: string;
  quality?: string;
  region?: string;
  /** Remaining units for the current account period, before this request. */
  remaining?: Record<string, number>;
  usageBefore?: Record<string, number>;
  items?: Record<string, number[]>;
  /** Calendar revision -> year -> excluded local dates. A missing year is unknown. */
  calendars?: Record<string, Record<string, string[]>>;
}

export interface BillingEstimate {
  currency: string;
  subtotal: string;
  status: "estimated" | "partial" | "unknown" | "included" | "blocked";
  lines: {
    lineId: string;
    meter: string;
    quantity: number | null;
    rate: string | null;
    amount: string | null;
    rules: string[];
  }[];
  missing: string[];
}
