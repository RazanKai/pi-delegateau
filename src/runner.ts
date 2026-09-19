import type { ChildEvent, ChildRequest, ChildResult, ModelIdentity } from "./types.js";

export interface SpawnResult {
  exitCode: number;
  observedExit: boolean;
}

export interface ChildSpawner {
  spawn(request: ChildRequest, emit: (event: ChildEvent) => void): Promise<SpawnResult>;
}

function modelFromEvidence(value: string | undefined): ModelIdentity | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function appendBounded(current: string, next: string, limit: number): string {
  if (limit <= 0) return "";
  const combined = current + next;
  if (combined.length <= limit) return combined;
  return combined.slice(combined.length - limit);
}

export class ChildRunner {
  constructor(private readonly spawner: ChildSpawner) {}

  async run(request: ChildRequest, onProgress?: (text: string) => void): Promise<ChildResult> {
    if (request.signal?.aborted) {
      return {
        status: "cancelled",
        output: "",
        appliedModel: request.model,
        diagnostics: [],
        observedExit: false,
      };
    }

    const outputLimit = request.maxOutputChars ?? 50_000;
    const diagnostics: string[] = [];
    let output = "";
    let appliedModel = request.model;
    let providerError: string | undefined;
    let sawTimeout = false;
    let limitExceeded = false;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = request.wallTimeMs
      ? setTimeout(() => {
          sawTimeout = true;
          controller.abort();
        }, request.wallTimeMs)
      : undefined;

    try {
      const spawnRequest = { ...request, signal: controller.signal };
      let turns = 0;
      const process = await this.spawner.spawn(spawnRequest, (event) => {
        if (event.type === "assistant") {
          turns += 1;
          if (request.maxTurns !== undefined && turns > request.maxTurns) {
            limitExceeded = true;
            controller.abort();
          }
          output = appendBounded(output, event.text, outputLimit);
          const evidence = modelFromEvidence(event.model);
          if (evidence) appliedModel = evidence;
          if (event.errorMessage || event.stopReason === "error") providerError = event.errorMessage ?? "Child provider reported an error";
        } else if (event.type === "progress") {
          onProgress?.(event.text);
        } else {
          diagnostics.push(event.text.slice(-2_000));
        }
      });

      const cancelled = request.signal?.aborted === true;
      const status = cancelled
        ? "cancelled"
        : limitExceeded
          ? "limit-exceeded"
          : sawTimeout
          ? "timed-out"
          : providerError || process.exitCode !== 0 || !process.observedExit
            ? process.observedExit
              ? "failed"
              : "launch-error"
            : "success";
      return {
        status,
        output,
        appliedModel,
        exitCode: process.exitCode,
        ...(providerError ? { error: providerError } : {}),
        diagnostics,
        observedExit: process.observedExit,
      };
    } catch (error) {
      const cancelled = request.signal?.aborted === true;
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: cancelled ? "cancelled" : limitExceeded ? "limit-exceeded" : sawTimeout ? "timed-out" : "launch-error",
        output,
        appliedModel,
        error: errorMessage,
        diagnostics,
        observedExit: false,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export { modelFromEvidence };
