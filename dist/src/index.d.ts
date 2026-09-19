import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
declare const CHILD_TOOLS: Set<string>;
declare const DelegateTaskParams: Type.TObject<{
    agent: Type.TString;
    task: Type.TString;
    expectedOutput: Type.TOptional<Type.TString>;
    context: Type.TOptional<Type.TString>;
}>;
type DelegateTaskParams = Static<typeof DelegateTaskParams>;
export default function (pi: ExtensionAPI): void;
export { DelegateTaskParams, CHILD_TOOLS };
