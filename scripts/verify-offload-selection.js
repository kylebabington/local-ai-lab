import assert from "node:assert/strict";

/**
 * Mirrors ui/src/lib/offloadSelection.ts for a Node regression check.
 * Opening / restoring a plan must not implicitly select every file.
 */
function selectionForLoadedPlan(plan, previousSelected) {
    const selectableIds = new Set(
        plan.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
    );

    if (!previousSelected) {
        return new Set();
    }

    const preserved = new Set();
    for (const id of previousSelected) {
        if (selectableIds.has(id)) {
            preserved.add(id);
        }
    }
    return preserved;
}

const plan = {
    entries: [
        { id: "a", selectable: true },
        { id: "b", selectable: true },
        { id: "c", selectable: false },
    ],
};

const fresh = selectionForLoadedPlan(plan, null);
assert.equal(fresh.size, 0, "fresh plan load must select nothing");

const restored = selectionForLoadedPlan(plan, ["a", "c", "missing"]);
assert.deepEqual([...restored], ["a"], "only prior selectable ids are preserved");

console.log("verify-offload-selection: ok");
