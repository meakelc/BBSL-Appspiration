The active review instructions (edge-case-hunter.md) specify a plain JSON output format, not the ReportFindings tool. Correcting course — here is the actual review result:

```json
[
  {
    "location": "src/lib/core/projection/league-clock.ts:247-262",
    "trigger_condition": "origin+LEAGUE_CLOCK crosses year 9999→10000, producing a 5-digit year",
    "guard_snippet": "if (year > 9999 || year < 0) return null;",
    "potential_consequence": "formatInstant emits an ISO string its own parseInstant regex rejects, breaking round-trip"
  },
  {
    "location": "src/lib/core/projection/nominations.ts:138-141",
    "trigger_condition": "fantraxPlayerId or teamId is a whitespace-only string (e.g. ' ')",
    "guard_snippet": "if (fantraxPlayerId.trim() === '') return null;",
    "potential_consequence": "phantom board/slot entry keyed on whitespace, indistinguishable from a real id"
  },
  {
    "location": "src/routes/nominate/+page.server.ts:65",
    "trigger_condition": "manager.teamName is an empty string rather than null/undefined",
    "guard_snippet": "teamName: manager.teamName || manager.teamId",
    "potential_consequence": "blank team name flows into stored payload and later refusal sentences shown to other Managers"
  }
]
```