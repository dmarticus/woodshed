// Declarative PostHog insight definitions. Print with `bun scripts/analytics-dashboard.ts`.
// Apply through the Personal PostHog connection; the app never needs a management API token.
const exact = (key: string, value: string | number) => ({ key, value, operator: "exact", type: "event" });
const v2 = exact("schema_version", 2);
const fresh = [v2, exact("baseline", "false")];
const firstReady = [...fresh, exact("first_ready", "true")];
const series = (event: string, properties = [v2], extra = {}) => ({ kind: "EventsNode", event, name: event, math: "total", properties, ...extra });
const trend = (items: unknown[], display = "ActionsLineGraph", extra = {}) => ({ kind: "TrendsQuery", series: items, interval: "day", dateRange: { date_from: "-30d" }, filterTestAccounts: false, trendsFilter: { display, showLegend: items.length > 1, ...extra } });
const insight = (name: string, description: string, source: unknown) => ({ name, description, query: { kind: "InsightVizNode", source } });
export const woodshedInsights = [
  insight("PRs entering maintenance", "New maintenance episodes recorded after tracking began. Existing PRs at rollout are excluded.", trend([series("woodshed_pr_enrolled", fresh)], "Metric", { metricSummary: "total", metricShowChange: false })),
  insight("PRs reaching verified readiness", "First verified readiness per new maintenance episode. Publication alone does not count.", trend([series("woodshed_pr_ready", firstReady)], "Metric", { metricSummary: "total", metricShowChange: false })),
  insight("Estimated model usage · USD", "Sum of observed cost changes across repairs, investigations, and routing checks. Not subscription charges.", trend([series("woodshed_run_cost_updated", [v2, exact("cost_known", "true")], { math: "sum", math_property: "cost_usd_delta" })], "Metric", { metricSummary: "total", metricShowChange: false, aggregationAxisFormat: "currency", decimalPlaces: 2 })),
  insight("Time to first readiness", "Median and p90 time from enrollment to verified readiness. Incomplete baseline episodes are excluded.", trend([series("woodshed_pr_ready", firstReady, { math: "median", math_property: "elapsed_ms", custom_name: "Median" }), series("woodshed_pr_ready", firstReady, { math: "p90", math_property: "elapsed_ms", custom_name: "p90" })], "ActionsLineGraph", { aggregationAxisFormat: "duration_ms" })),
  insight("Ready without an owner decision", "Share of newly tracked ready episodes with no recorded Needs you decision. External human work is unknown.", trend([series("woodshed_pr_ready", [...firstReady, exact("without_owner_decision", "true")], { custom_name: "No owner decision" }), series("woodshed_pr_ready", firstReady, { custom_name: "All ready episodes" })], "ActionsLineGraph", { formulaNodes: [{ formula: "A / B" }], aggregationAxisFormat: "percentage_scaled", showLegend: false })),
  insight("Run starts by kind", "Unique run starts, excluding baseline observations. Resumption is a separate event and does not add a start.", { ...trend([series("woodshed_run_started", fresh)], "ActionsBarValue"), breakdownFilter: { breakdowns: [{ property: "kind", type: "event" }] } }),
  insight("Action failures", "Failed owner and agent requests by operation. Error text, prompts, and code are excluded.", { ...trend([series("woodshed_action_failed")], "ActionsBarValue"), breakdownFilter: { breakdowns: [{ property: "action", type: "event" }] } }),
  { name: "PR outcomes, owner decisions, and cost", description: "Observed maintenance episodes, including rollout baselines. Cost is estimated from additive updates; missing usage remains visible.", query: { kind: "DataVisualizationNode", display: "ActionsTable", source: { kind: "HogQLQuery", query: `WITH run_usage AS (
  SELECT properties.episode_id AS episode, properties.run_id AS run,
    sumIf(toFloat(properties.cost_usd_delta), event = 'woodshed_run_cost_updated') AS usd,
    argMax(toInt(properties.cost_known), timestamp) AS known
  FROM events
  WHERE timestamp >= now() - INTERVAL 30 DAY AND properties.schema_version = 2
    AND event IN ('woodshed_run_cost_updated', 'woodshed_run_state_changed')
  GROUP BY episode, run
), episode_usage AS (
  SELECT episode, sum(usd) AS usd, countIf(known = 0) AS unknown_runs
  FROM run_usage GROUP BY episode
), outcomes AS (
  SELECT properties.episode_id AS episode,
    argMaxIf(properties.to_phase, timestamp, event = 'woodshed_pr_state_changed') AS latest_phase,
    max(toInt(properties.baseline)) AS rollout_baseline,
    uniqExactIf(properties.decision_id, event = 'woodshed_attention_raised') AS owner_decisions,
    if(rollout_baseline = 0 AND countIf(event = 'woodshed_pr_ready' AND properties.first_ready = true) > 0,
      round(minIf(toFloat(properties.elapsed_ms) / 60000, event = 'woodshed_pr_ready' AND properties.first_ready = true), 1), NULL) AS first_ready_minutes
  FROM events
  WHERE timestamp >= now() - INTERVAL 30 DAY AND properties.schema_version = 2
    AND properties.episode_id IS NOT NULL
    AND event IN ('woodshed_pr_enrolled', 'woodshed_pr_state_changed', 'woodshed_pr_ready', 'woodshed_attention_raised')
  GROUP BY episode
)
SELECT outcomes.episode AS maintenance_episode, latest_phase, rollout_baseline, owner_decisions, first_ready_minutes,
  if(coalesce(unknown_runs, 0) > 0, NULL, round(coalesce(usd, 0), 4)) AS estimated_usd,
  coalesce(unknown_runs, 0) AS runs_with_unknown_usage
FROM outcomes LEFT JOIN episode_usage ON outcomes.episode = episode_usage.episode
ORDER BY owner_decisions DESC
LIMIT 100` } } },
];
if (import.meta.main) console.log(JSON.stringify(woodshedInsights, null, 2));
