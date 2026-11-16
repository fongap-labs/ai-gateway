export type NodeHealthEvidence = Readonly<{
  status: string;
  total_successes: number;
}>;

export function summarizeHealthEvidence(endpoints: ReadonlyArray<NodeHealthEvidence>, configuredEligible: number) {
  const blocked = (e: NodeHealthEvidence) => ['disabled', 'cooldown', 'cooling_down'].includes(e.status);
  const cooling = endpoints.filter((e) => e.status === 'cooldown' || e.status === 'cooling_down').length;
  const disabled = endpoints.filter((e) => e.status === 'disabled').length;
  const observedHealthy = endpoints.filter((e) => e.total_successes > 0 && !blocked(e)).length;
  const observedResponsive = endpoints.filter((e) => e.status === 'observed_healthy' || (e.status === 'active' && e.total_successes > 0)).length;
  const unknown = endpoints.filter((e) => e.total_successes === 0 && !blocked(e)).length;
  const configuredWithoutAccountBlock = Math.max(0, configuredEligible - cooling - disabled);
  return { cooling, disabled, observedHealthy, observedResponsive, unknown, configuredWithoutAccountBlock };
}
