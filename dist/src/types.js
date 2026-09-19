/** Thinking effort conventionally paired with each level. */
export const COMPLEXITY_EFFORT = {
    trivial: "minimal",
    simple: "low",
    moderate: "medium",
    advanced: "high",
    complex: "xhigh",
    frontier: "max",
};
export const COMPLEXITY_LEVELS = ["trivial", "simple", "moderate", "advanced", "complex", "frontier"];
export function modelKey(identity) {
    return `${identity.provider}/${identity.id}`;
}
export function sameModel(a, b) {
    return a.provider === b.provider && a.id === b.id;
}
