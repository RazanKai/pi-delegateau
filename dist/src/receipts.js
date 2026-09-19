export function sanitizeError(message, secrets = []) {
    let result = message.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[redacted]");
    for (const secret of secrets)
        if (secret)
            result = result.split(secret).join("[redacted]");
    return result.slice(0, 2_000);
}
export function buildReceipt(input) {
    const { task: _task, ...safe } = input;
    return JSON.parse(JSON.stringify(safe));
}
