/**
 * Profile-named CodeBuddy one-shot subagent provider. Every accepted run
 * spawns `codebuddy --acp` in the delegating Session's workspace under the
 * shared subprocess owner, opens one fresh ACP session, sends the single text
 * task, and returns the final answer or a safe failure diagnostic.
 *
 * @module @local/dsh-subagent-codebuddy
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export declare const name = "subagent-codebuddy";
export declare const inject: string[];

/** Unattended CodeBuddy permission policy for tool permission requests. */
export type CodeBuddyPermissionMode = "dontAsk" | "acceptEdits" | "bypassPermissions";

/** Deployment-owned model, command, permission, environment, and process-release settings. */
export interface Config {
    /** Provider name on `ctx.subagents` (default `codebuddy`). */
    providerName?: string;
    /** Model id fixed for this instance; sent through `session/set_model` before the prompt. */
    model?: string;
    /** Absolute path or command name of the `codebuddy` executable (default `codebuddy`). */
    command?: string;
    /**
     * Explicit environment entries layered over the subprocess seam's
     * credential-scrubbed parent environment.
     */
    env?: Record<string, string>;
    /**
     * Unattended permission policy fixed for this Provider instance. Defaults to
     * `dontAsk` (deny tool permission requests); `acceptEdits` allows edit-class
     * tools; `bypassPermissions` allows everything (dangerous, opt-in).
     */
    permissionMode?: CodeBuddyPermissionMode;
    /** Grace in milliseconds between CodeBuddy managed-range termination tiers. */
    disposeGraceMs?: number;
    /** Milliseconds to wait for ACP initialize + session/new before failing startup. */
    startupTimeoutMs?: number;
}
export declare const Config: z<Config>;

/**
 * Register one Profile-named CodeBuddy provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model/command, permission policy, environment, and disposal grace.
 */
export declare function apply(ctx: Context, config: Config): void;
