export type PolicyConfig = {
  maxAttempts: number;
  tierAttempts?: { tier1?: number; tier2?: number } | null;
  hedge?: { enabled?: boolean; delayMs?: number; tiers?: ReadonlyArray<'tier1' | 'tier2'> } | null;
  headersTimeoutMs?: number | null;
  firstEventTimeoutMs?: number | null;
  failoverBudgetMs?: number | null;
  maxInFlight?: number | null;
};
