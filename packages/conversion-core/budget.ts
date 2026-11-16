// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { IrEvent } from './ir.ts';
import { isRecord } from './ir.ts';

export type MatrixConversionBudget = {
  maxEvents: number;
  maxOutputUnits: number;
  maxToolEvents: number;
  maxToolArgUnits: number;
  maxOutputTokens: number;
};

export type BudgetStopReason = 'events' | 'output_units' | 'tool_events' | 'tool_args' | 'output_tokens';

export class ConversionBudgetStop extends Error {
  readonly reason: BudgetStopReason;

  constructor(reason: BudgetStopReason) {
    super(`matrix conversion budget stop: ${reason}`);
    this.name = 'ConversionBudgetStop';
    this.reason = reason;
  }
}

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
