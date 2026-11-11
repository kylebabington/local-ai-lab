import type { OffloadPlan } from "../types";

/**
 * Default selection when a plan is loaded or created.
 * Never auto-selects candidates — only preserves explicitly chosen IDs that
 * remain selectable on the current plan.
 */
export function selectionForLoadedPlan(
    plan: OffloadPlan,
    previousSelected?: Iterable<string> | null,
): Set<string> {
    const selectableIds = new Set(
        plan.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
    );

    if (!previousSelected) {
        return new Set();
    }

    const preserved = new Set<string>();
    for (const id of previousSelected) {
        if (selectableIds.has(id)) {
            preserved.add(id);
        }
    }
    return preserved;
}
