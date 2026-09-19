export function modelKey(identity) {
    return `${identity.provider}/${identity.id}`;
}
export function sameModel(a, b) {
    return a.provider === b.provider && a.id === b.id;
}
