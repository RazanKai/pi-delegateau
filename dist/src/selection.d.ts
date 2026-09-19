import { type DelegateRequest, type JevChoiceAnswer, type JevChoiceInput, type SelectionResult } from "./types.js";
export interface ChoiceRuntime {
    choose(input: JevChoiceInput): Promise<JevChoiceAnswer>;
    signal?: AbortSignal;
}
declare const CHOICE_QUESTION = "Which eligible model best fits this assignment under the supplied routing preference and candidate profiles?";
export declare function selectModel(request: DelegateRequest, runtime: ChoiceRuntime): Promise<SelectionResult>;
export { CHOICE_QUESTION };
