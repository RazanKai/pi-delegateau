import { type DelegateRequest, type JevChoiceAnswer, type JevChoiceInput, type ModelIdentity, type SelectionResult } from "./types.js";
export interface ChoiceRuntime {
    choose(input: JevChoiceInput): Promise<JevChoiceAnswer>;
    signal?: AbortSignal;
}
declare const CHOICE_QUESTION = "Which eligible model best fits this assignment under the supplied routing preference and candidate profiles?";
/**
 * Side-effect-free resolution of the launch model for a request, exactly as
 * dispatch will apply it: pin -> fixed -> single-candidate -> jev -> fallback.
 * The gate uses this to decide child availability, so its notion of "a usable
 * child exists" matches what delegate_task can actually launch (F09).
 */
export declare function resolveLaunchModel(request: DelegateRequest, choose?: (input: JevChoiceInput) => Promise<JevChoiceAnswer>): ModelIdentity | undefined;
export declare function selectModel(request: DelegateRequest, runtime: ChoiceRuntime): Promise<SelectionResult>;
export { CHOICE_QUESTION };
