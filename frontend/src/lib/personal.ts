import type { TeamDetail } from "./types";

/** A personal form returns to the nested tab in its original team. */
export function expensesPath(team: Pick<TeamDetail, "id" | "parent_team_id">): string {
  return team.parent_team_id
    ? `/teams/${team.parent_team_id}?tab=expenses&scope=personal`
    : `/teams/${team.id}?tab=expenses`;
}
