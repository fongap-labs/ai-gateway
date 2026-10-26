// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Translation budget (AIG_CONVERSION_*): a per-request ceiling on the IR
// translation work and produced output of one matrix-converted reply.
//
// Why: a runaway generation (misconfigured max_tokens, a looping model, a
// hostile prompt) otherwise translates unbounded CPU inside the isolate and
// pays unbounded upstream egress for a reply the operator never asked the
// matrix to serve at this size. The matrix translate path had no bound of its
// own; the buffered-reader bounds only cover the raw upstream body.
//
// Counted units (all per ONE reply):
//   events       - decoded IR events (start/text/think/tool_*/usage/...);
//                  also bounds the per-chunk protocol envelope amplification:
//                  every event renders at most a few frames, so the client
//                  stream size stays within ~envelope-overhead x maxEvents.
//   outputUnits  - decoded output growth (UTF-16 code units of text/think/
//                  sealed/tool-args/signature), a portable byte proxy.
//   toolEvents   - tool_start + tool_args events combined.
//   toolArgBytes - cumulative argument length of the OPEN tool call, reset on
//                  every tool_start.
//   outputTokens - reported cumulative output tokens; enforced only when a
//                  usage event carries one (Anthropic reports deltas
//                  mid-stream, Chat/Responses report once at the end), so 0
//                  (disabled) is the default.
//
// Stopping is cooperative: callers probe `beginEvent(event)` before feeding
// the collector/encoder and `chargeOutput(units)` before delivering growth, so
// the reply is cut BEFORE the piece that would exceed the budget.

import type { IrEvent } from './ir.ts';
import { isRecord } from './ir.ts';

export type MatrixConversionBudget = {
  maxEvents: number;
  maxOutputUnits: number;
  maxToolEvents: number;
  maxToolArgUnits: number;
  /** 0 disables the token ceiling. */
  maxOutputTokens: number;
};

export type BudgetStopReason = 'events' | 'output_units' | 'tool_events' | 'tool_args' | 'output_tokens';

/** Thrown by the object-collection path when the budget expires (AIG_CONVERSION_BUDGET_MODE=error). */
export class ConversionBudgetStop extends Error {
  // A plain field, not a constructor parameter property: the test pack loads
  // these sources through Node's strip-only TypeScript mode, which rejects
  // parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  readonly reason: BudgetStopReason;

  constructor(reason: BudgetStopReason) {
    super(`matrix conversion budget stop: ${reason}`);
    this.name = 'ConversionBudgetStop';
    this.reason = reason;
  }
}

/** Output growth one IR event contributes, in UTF-16 code units. */
export function outputUnitsOf(event: IrEvent): number {
  switch (event.type) {
    case 'text':
    case 'think':
    case 'sealed':
      return event.text?.length ?? 0;
    case 'tool_args':
      return event.args.length;
    case 'sig':
      return event.signature.length;
    default:
      return 0;
  }
}

/** Cumulative output-token count carried by a raw usage JSON (all known nestings). */
export function usageOutputTokens(raw: unknown): number | undefined {
  const at = (container: unknown): number | undefined => {
    if (!isRecord(container)) return undefined;
    for (const key of ['output_tokens', 'completion_tokens']) {
      const value = container[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  if (!isRecord(raw)) return undefined;
  // Chat nests under .usage, Anthropic message_start under .message.usage,
  // message_delta under .usage, Responses under .response.usage.
  const candidates = [
    raw,
    raw.usage,
    raw.message,
    isRecord(raw.message) ? raw.message.usage : undefined,
    raw.response,
    isRecord(raw.response) ? raw.response.usage : undefined,
  ];
  for (const container of candidates) {
    const tokens = at(container);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}

export class MatrixBudgetTracker {
  stopped: BudgetStopReason | null = null;
  private readonly cfg: MatrixConversionBudget;
  private events = 0;
  private outputUnits = 0;
  private toolEvents = 0;
  private currentToolArgUnits = 0;

  constructor(cfg: MatrixConversionBudget) {
    this.cfg = cfg;
  }

  /** Probe one decoded IR event. false means the caller must stop before using it. */
  beginEvent(event: IrEvent): boolean {
    if (this.stopped !== null) return false;
    this.events++;
    if (this.events > this.cfg.maxEvents) return this.stop('events');
    if (event.type === 'tool_start') {
      this.toolEvents++;
      this.currentToolArgUnits = 0;
      if (this.toolEvents > this.cfg.maxToolEvents) return this.stop('tool_events');
      return true;
    }
    if (event.type === 'tool_args') {
      this.toolEvents++;
      this.currentToolArgUnits += event.args.length;
      if (this.toolEvents > this.cfg.maxToolEvents) return this.stop('tool_events');
      if (this.currentToolArgUnits > this.cfg.maxToolArgUnits) return this.stop('tool_args');
      return true;
    }
    if (event.type === 'usage' && this.cfg.maxOutputTokens > 0) {
      const tokens = usageOutputTokens(event.raw);
      if (tokens !== undefined && tokens > this.cfg.maxOutputTokens) return this.stop('output_tokens');
    }
    return true;
  }

  /** Probe output growth. false means the caller must stop before delivering it. */
  chargeOutput(units: number): boolean {
    if (this.stopped !== null) return false;
    this.outputUnits += units;
    if (this.outputUnits > this.cfg.maxOutputUnits) return this.stop('output_units');
    return true;
  }

  private stop(reason: BudgetStopReason): boolean {
    this.stopped = reason;
    return false;
  }
}

export function createMatrixBudget(cfg: MatrixConversionBudget | null | undefined): MatrixBudgetTracker | null {
  return cfg ? new MatrixBudgetTracker(cfg) : null;
}
