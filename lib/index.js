// @ts-check
/**
 * One-shot CodeBuddy subagent provider over the Agent Client Protocol.
 *
 * Every accepted run spawns `codebuddy --acp` (NDJSON JSON-RPC over stdio) in
 * the delegating Session's workspace under the shared subprocess owner, opens
 * one fresh ACP session, sends the single text task, and maps only the strict
 * ACP `end_turn` result to completion. Reasoning, tool traffic, stderr, and
 * workspace diffs stay out of the parent Session; the final answer (or a safe
 * failure diagnostic) is the only model-visible outcome.
 *
 * The provider mirrors the structure of the shipped Claude Code subagent
 * backend (`@deepseek-ai/dsh-subagent-claude-code`): the same out-of-process
 * capability advertisement (`NO_START_CAPABILITIES`, `inheritsParentContext:
 * false`), the same `settleRunResult`/`subprocessRunHandle` publication, and
 * the same managed-range termination ladder. The difference is the wire
 * protocol: Claude Code drives the official Agent SDK, while this backend
 * speaks ACP directly over stdio with no external SDK dependency.
 *
 * @module @local/dsh-subagent-codebuddy
 */
import z from "@deepseek-ai/schemastery";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import {
  NO_START_CAPABILITIES,
  assertPositiveFinite,
  assertUsableCwd,
  settleRunResult,
  subprocessRunHandle,
} from "@deepseek-ai/dsh-subagent";
import { randomUUID } from "node:crypto";
import { brandString } from "@deepseek-ai/dsh-brand";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

const name = "subagent-codebuddy";
const inject = ["subagents", "subprocess"];

const DEFAULT_PROVIDER_NAME = "codebuddy";
const DEFAULT_DISPOSE_GRACE_MS = 3000;
const DEFAULT_ACP_STARTUP_TIMEOUT_MS = 20000;

/** CodeBuddy ACP permission modes this unattended backend understands. */
const CODEBUDDY_PERMISSION_MODES = ["dontAsk", "acceptEdits", "bypassPermissions"];

/** Safe default for unattended CodeBuddy runs: deny everything not already allowed. */
const DEFAULT_CODEBUDDY_PERMISSION_MODE = "dontAsk";

const Config = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  /** Optional model id; sent through `session/set_model` before the prompt. */
  model: z.string().min(1),
  /** Optional absolute path or command name of the `codebuddy` executable. */
  command: z.string().min(1).default("codebuddy"),
  /** Explicit environment entries layered over the credential-scrubbed parent environment. */
  env: z.dict(z.string()).default({}),
  /**
   * Unattended permission policy for tool permission requests:
   * `dontAsk` denies them, `acceptEdits` allows edit-class tools and denies the
   * rest, `bypassPermissions` allows everything (dangerous; requires explicit
   * configuration).
   */
  permissionMode: z
    .union([...CODEBUDDY_PERMISSION_MODES])
    .default(DEFAULT_CODEBUDDY_PERMISSION_MODE),
  /** Grace in milliseconds between CodeBuddy managed-range termination tiers. */
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  /** Milliseconds to wait for `initialize` + `session/new` before failing startup. */
  startupTimeoutMs: z.number().default(DEFAULT_ACP_STARTUP_TIMEOUT_MS),
});

function failureDiagnostic(facts) {
  const fields = [
    "product: CodeBuddy",
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ];
  const exitCode = facts.outcome?.exitCode;
  if (exitCode !== null && exitCode !== void 0) fields.push(`exit code: ${exitCode}`);
  const signal = facts.outcome?.signal;
  if (signal !== null && signal !== void 0) fields.push(`signal: ${signal}`);
  return `Product subagent failure (${fields.join("; ")})`;
}

class CodeBuddyFailure extends Error {
  constructor(facts, cause) {
    super(`subagent-codebuddy: ${failureDiagnostic(facts)}`, cause === void 0 ? void 0 : { cause });
    this.facts = facts;
    this.name = "CodeBuddyFailure";
  }
}

/** Map a native ACP prompt stop reason to a safe failure category. */
function promptFailureCategory(stopReason, errorMessage) {
  if (stopReason === "refusal") return "refusal";
  if (stopReason === "cancelled") return "aborted";
  if (errorMessage !== void 0 && errorMessage.length > 0) return "product-error";
  return "unknown";
}

/** Validate and preserve the one-shot task before crossing the process boundary. */
function textTask(prompt) {
  if (prompt.length === 0) throw new Error("subagent-codebuddy: the one-shot task must contain only text blocks");
  const texts = [];
  for (const block of prompt) {
    if (block.type !== "text") throw new Error("subagent-codebuddy: the one-shot task must contain only text blocks");
    texts.push(block.text);
  }
  if (texts.every((text) => text.trim().length === 0)) throw new Error("subagent-codebuddy: the one-shot task must not be empty");
  return texts.join("");
}

function thrown(value) {
  /* v8 ignore next -- typed subprocess failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Minimal NDJSON JSON-RPC 2.0 client over one subprocess managed range.
 * `codebuddy --acp` speaks NDJSON on stdio; non-JSON lines on stdout are
 * tolerated and counted (the CLI is known to print stray diagnostics there).
 */
class AcpConnection {
  constructor(child, logger, logPrefix) {
    this.child = child;
    this.logger = logger;
    this.logPrefix = logPrefix;
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = () => {};
    this.dirtyLines = 0;
    this.exited = false;
    this.exitOutcome = void 0;
    this.rl = createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    child.done.then(
      (outcome) => {
        this.exited = true;
        this.exitOutcome = outcome;
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error(`${entry.method}: process exited before response`));
        }
        this.pending.clear();
      },
      (error) => {
        this.exited = true;
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(thrown(error));
        }
        this.pending.clear();
      }
    );
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.dirtyLines += 1;
      this.logger.debug(`%s: non-JSON stdout line (%d): %s`, this.logPrefix, this.dirtyLines, line.slice(0, 120));
      return;
    }
    if (message.method !== void 0) {
      // server → client notification (no id)
      if (message.id === void 0) {
        try {
          this.onNotification(message);
        } catch (error) {
          this.logger.warn(`%s: notification handler threw: %o`, this.logPrefix, error);
        }
        return;
      }
      // server → client request with an id: answer with an error we own.
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `subagent-codebuddy: method not handled: ${message.method}` } });
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === void 0) {
      this.logger.debug(`%s: orphan response id %s`, this.logPrefix, message.id);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== void 0) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
    else pending.resolve(message.result);
  }

  send(object) {
    try {
      this.child.stdin.write(JSON.stringify(object) + "\n");
    } catch (error) {
      // stdin may be closed after the child exits; every pending request then rejects on done.
      this.logger.debug(`%s: stdin write failed: %o`, this.logPrefix, error);
    }
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  dispose() {
    this.rl.close();
  }
}

/**
 * Run one ACP session inside a managed CodeBuddy process and settle the
 * one-shot shared run.
 * @param {object} spec - cwd, env, spawn, permission policy, and diagnostics.
 * @param {object} request - the shared subagent request.
 * @returns the published run handle.
 */
async function startCodeBuddyRun(request, spec) {
  const task = textTask(request.prompt);
  if (request.signal.aborted) throw new Error("subagent-codebuddy: request was aborted before ACP startup");

  const controller = new AbortController();
  const requestCancel = () => {
    if (!controller.signal.aborted) controller.abort(new Error("subagent-codebuddy: run cancelled locally"));
  };
  const onAbort = () => {
    requestCancel();
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  const reportFailure = (error) => {
    try {
      spec.onError?.(error, "error");
    } catch {}
  };

  let child;
  let connection;
  let sessionId;
  let diagnostic;
  const captureDiagnostic = (value) => {
    diagnostic = value;
  };
  const capturePermissionDiagnostic = (value) => {
    diagnostic = diagnostic === void 0 ? value : `${diagnostic}\n${value}`;
  };
  const prependFailureDiagnostic = (facts) => {
    const failure = failureDiagnostic(facts);
    diagnostic = diagnostic === void 0 ? failure : `${failure}\n${diagnostic}`;
  };

  const unattendedDecision = (toolName, kind) => {
    const mode = spec.permissionMode;
    if (mode === "bypassPermissions") {
      capturePermissionDiagnostic(`CodeBuddy unattended decision (mode: ${mode}; tool: ${toolName}; decision: allow): permission mode allows everything`);
      return "allow";
    }
    if (mode === "acceptEdits" && isEditClassTool(toolName)) {
      capturePermissionDiagnostic(`CodeBuddy unattended decision (mode: ${mode}; tool: ${toolName}; decision: allow): edit-class tool`);
      return "allow";
    }
    capturePermissionDiagnostic(`CodeBuddy unattended decision (mode: ${mode}; tool: ${toolName}; decision: deny): the provider does not request human approval`);
    return "deny";
  };

  const onInterruption = (params) => {
    const toolCallId = params?.toolCallId;
    const toolName = params?.toolName ?? "unknown";
    if (toolCallId === void 0) {
      capturePermissionDiagnostic(`CodeBuddy interruption without a toolCallId (tool: ${toolName}); ignored`);
      return;
    }
    const decision = unattendedDecision(toolName, params?.kind);
    connection.request("_codebuddy.ai/resolveInterruption", {
      sessionId,
      toolCallId,
      decision,
    }).catch((error) => {
      capturePermissionDiagnostic(`CodeBuddy interruption resolve failed (tool: ${toolName}): ${error.message}`);
    });
  };

  // Keep the local cancellation owner alive across startup cleanup.
  const cancelledBeforeCleanup = () => controller.signal.aborted;
  const isRequestAborted = () => request.signal.aborted;

  // Output collectors live here, before the notification handler is installed,
  // so agent_message_chunk notifications can always append into them.
  let outputText = "";
  const captureOutputText = (text) => {
    outputText += text;
  };

  try {
    child = spec.spawn({
      argv: [spec.command, "--acp"],
      cwd: spec.cwd,
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
      graceMs: spec.disposeGraceMs,
      signal: controller.signal,
      env: { ...scrubbedParentEnv(), ...spec.env },
    });
    connection = new AcpConnection(child, spec.logger, `subagent-codebuddy "${spec.providerName}"`);
    connection.onNotification = (message) => {
      if (message.method === "session/update") {
        const update = message.params?.update;
        const sessionUpdate = update?.sessionUpdate;
        if (sessionUpdate === "agent_message_chunk") {
          const text = update?.content?.text;
          if (typeof text === "string" && text.length > 0) captureOutputText(text);
        } else if (sessionUpdate === "session_end") {
          // completion is decided by the request response; nothing to record here.
        } else if (sessionUpdate === "interruption_request") {
          onInterruption(message.params);
        }
        return;
      }
      if (message.method === "session/request_permission") {
        // Legacy permission request shape observed on some builds.
        const options = message.params?.options ?? [];
        const toolName = message.params?.toolName ?? message.params?.rawInput?.toolId ?? "unknown";
        const allow = options.find((option) => /allow/i.test(option.optionId ?? option.name ?? ""));
        const pick = unattendedDecision(toolName, "permission") === "allow" ? allow : options.find((option) => /reject|deny/i.test(option.optionId ?? option.name ?? ""));
        if (pick !== void 0) {
          connection.send({
            jsonrpc: "2.0",
            id: message.id,
            result: { outcome: { outcome: "selected", optionId: pick.optionId } },
          });
        } else {
          connection.send({
            jsonrpc: "2.0",
            id: message.id,
            result: { outcome: { outcome: "cancelled" } },
          });
        }
        return;
      }
      if (message.method === "_codebuddy.ai/delegateTool") {
        // A delegate tool call is not part of the unattended subagent surface;
        // decline with a safe error so the child continues without DSH tools.
        connection.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "subagent-codebuddy: delegate tool calls are not supported for subagent runs" },
        });
        return;
      }
    };

    const startupFacts = () => ({
      stage: "query-start",
      category: "unknown",
      outcome: child?.outcome,
    });

    const initRace = abortAfter(request.signal, "request aborted during initialize");
    const initCancel = abortAfter(controller.signal, "run cancelled during initialize");
    let initSettled;
    try {
      initSettled = await Promise.race([
        connection.request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "dsh-subagent-codebuddy", version: "0.1.0" },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
        }, spec.startupTimeoutMs),
        initRace,
        initCancel,
      ]);
    } finally {
      initRace.dispose();
      initCancel.dispose();
    }
    if (isRequestAborted()) throw new Error("subagent-codebuddy: request was aborted during ACP startup");
    if (cancelledBeforeCleanup()) throw new Error("subagent-codebuddy: run cancelled during ACP startup");

    const newRace = abortAfter(request.signal, "request aborted during session/new");
    const newCancel = abortAfter(controller.signal, "run cancelled during session/new");
    let created;
    try {
      created = await Promise.race([
        connection.request("session/new", {
          cwd: spec.cwd,
          mcpServers: [],
        }, spec.startupTimeoutMs),
        newRace,
        newCancel,
      ]);
    } finally {
      newRace.dispose();
      newCancel.dispose();
    }
    if (isRequestAborted()) throw new Error("subagent-codebuddy: request was aborted during ACP startup");
    if (cancelledBeforeCleanup()) throw new Error("subagent-codebuddy: run cancelled during ACP startup");
    sessionId = created.sessionId;
    if (sessionId === void 0 || typeof sessionId !== "string") throw new Error("subagent-codebuddy: session/new returned no sessionId");

    if (spec.model !== void 0) {
      const modelRace = abortAfter(request.signal, "request aborted during session/set_model");
      try {
        await Promise.race([
          connection.request("session/set_model", { sessionId, modelId: spec.model }, spec.startupTimeoutMs),
          modelRace,
        ]);
      } finally {
        modelRace.dispose();
      }
      if (isRequestAborted()) throw new Error("subagent-codebuddy: request was aborted during ACP startup");
    }

    // ACP startup succeeded: from here the run is published and disposal owns cleanup.
  } catch (error) {
    request.signal.removeEventListener("abort", onAbort);
    await Promise.resolve();
    const startupFailure = (cause = error) => new CodeBuddyFailure({ ...startupFacts(), stage: "query-start", category: "unknown" }, thrown(cause));
    requestCancel();
    if (connection !== void 0) {
      try {
        await disposeAcpChild(connection, child);
      } catch (disposeError) {
        const aggregate = new AggregateError([startupFailure(), thrown(disposeError)], `${startupFailure().message}; ${disposeError.message}`);
        reportFailure(aggregate);
        throw aggregate;
      }
    }
    if (isRequestAborted() || cancelledBeforeCleanup()) throw new Error("subagent-codebuddy: request was aborted during ACP startup");
    const failure = startupFailure();
    reportFailure(failure);
    throw failure;
  }

  const publishedConnection = connection;
  const publishedChild = child;
  const publishedSessionId = sessionId;

  const attempt = async () => {
    const promptCancel = abortAfter(controller.signal, "run cancelled during prompt");
    let result;
    try {
      result = await Promise.race([
        publishedConnection.request("session/prompt", {
          sessionId: publishedSessionId,
          prompt: [{ type: "text", text: task }],
        }, /* no fixed timeout — the caller cancels long work */ 24 * 60 * 60 * 1000),
        publishedChild.done.then(
          () => {
            throw new Error("subagent-codebuddy: CodeBuddy process exited before the prompt finished");
          },
          (error) => {
            throw thrown(error);
          }
        ),
        promptCancel,
      ]);
    } finally {
      promptCancel.dispose();
    }
    const stopReason = result?.stopReason;
    const errorMessage = result?.errorMessage;
    if (stopReason === "cancelled") {
      const failure = new CodeBuddyFailure({
        stage: "query-run",
        category: "aborted",
        outcome: publishedChild.outcome,
      });
      capturePermissionDiagnostic(`CodeBuddy run cancelled (native stopReason: cancelled)`);
      throw failure;
    }
    if (stopReason !== "end_turn") {
      const failure = new CodeBuddyFailure(
        {
          stage: "query-run",
          category: promptFailureCategory(stopReason, errorMessage),
          outcome: publishedChild.outcome,
        },
        errorMessage !== void 0 && errorMessage.length > 0 ? new Error(errorMessage) : void 0
      );
      throw failure;
    }
    const answer = outputText.trim();
    if (answer.length === 0) {
      const failure = new CodeBuddyFailure({
        stage: "query-run",
        category: "invalid-result",
        outcome: publishedChild.outcome,
      });
      throw failure;
    }
    return {
      output: [{ type: "text", text: answer }],
      stopReason: "completed",
    };
  };

  const result = settleRunResult({
    attempt,
    collectOutput: () => [],
    collectDiagnostic: () => diagnostic,
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  });

  return subprocessRunHandle({
    id: brandString(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      try {
        await disposeAcpChild(publishedConnection, publishedChild, publishedSessionId);
      } catch (error) {
        const failure = thrown(error);
        reportFailure(failure);
        throw failure;
      }
    },
  });
}

/**
 * Send `session/cancel`, terminate the managed range, and wait for exit.
 * @param {AcpConnection} connection - the live NDJSON connection.
 * @param {object} child - the shared subprocess handle.
 * @param {string|undefined} sessionId - the ACP session, once created.
 */
async function disposeAcpChild(connection, child, sessionId) {
  const failures = [];
  try {
    if (sessionId !== void 0) connection.notify("session/cancel", { sessionId });
  } catch (error) {
    failures.push(thrown(error));
  }
  connection.dispose();
  try {
    child.terminate();
  } catch (error) {
    failures.push(thrown(error));
  }
  try {
    await child.waitForExit();
  } catch (error) {
    failures.push(thrown(error));
  }
  const firstFailure = failures[0];
  if (firstFailure !== void 0) {
    throw new CodeBuddyFailure(
      { stage: "teardown", category: "unknown", outcome: child.outcome },
      failures.length === 1 ? firstFailure : new AggregateError(failures, "CodeBuddy teardown failures")
    );
  }
  await child.done.catch(() => {});
}

/** Whether a tool name belongs to the edit class (acceptEdits policy). */
function isEditClassTool(toolName) {
  return /write|edit|insert|replace|patch|create|delete|rename|move|apply/i.test(toolName);
}

/**
 * Race a promise against a signal without leaking the listener. Returns a
 * promise that rejects when the signal aborts, carrying a `dispose()` that
 * removes the listener and releases the race once the caller is done.
 * @param {AbortSignal} signal - the signal to watch.
 * @param {string} message - rejection message when the signal aborts.
 * @returns {Promise<never> & { dispose: () => void }}
 */
function abortAfter(signal, message) {
  let reject;
  const failed = new Promise((_, rej) => {
    reject = rej;
  });
  failed.catch(() => {});
  let resolveCleanup;
  const cleanup = new Promise((resolve) => {
    resolveCleanup = resolve;
  });
  const onAbort = () => {
    reject(new Error(message));
    resolveCleanup();
  };
  const race = Object.assign(Promise.race([failed, cleanup]), {
    dispose() {
      signal.removeEventListener("abort", onAbort);
      resolveCleanup();
    },
  });
  if (signal.aborted) {
    queueMicrotask(() => reject(new Error(message)));
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return race;
}

class CodeBuddyProvider {
  constructor(providerName, ctx, config) {
    this.name = providerName;
    this.ctx = ctx;
    this.config = config;
    this.capabilities = NO_START_CAPABILITIES;
    this.inheritsParentContext = false;
  }

  async start(request) {
    let cwd;
    try {
      cwd = assertUsableCwd("subagent-codebuddy", "child cwd", request.cwd);
    } catch (error) {
      if (request.signal.aborted) throw new Error("subagent-codebuddy: request was aborted before ACP startup");
      const failure = new CodeBuddyFailure({ stage: "query-start", category: "unknown" }, thrown(error));
      this.ctx.logger.warn(`subagent-codebuddy "${this.name}": child start failed: %o`, failure);
      throw failure;
    }
    return startCodeBuddyRun(request, {
      cwd,
      providerName: this.name,
      command: this.config.command,
      ...(this.config.model === void 0 ? {} : { model: this.config.model }),
      permissionMode: this.config.permissionMode,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      startupTimeoutMs: this.config.startupTimeoutMs,
      spawn: (spawnSpec) => this.ctx.subprocess.spawn(spawnSpec),
      logger: this.ctx.logger,
      onError: (error, stopReason) => {
        this.ctx.logger.warn(`subagent-codebuddy "${this.name}": child run failed (${stopReason}): %o`, error);
      },
    });
  }
}

/**
 * Register one Profile-named CodeBuddy provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context carrying shared subagent and subprocess services.
 * @param {object} config - registry name, optional model/command, permission policy, environment, and disposal grace.
 */
function apply(ctx, config) {
  const resolved = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...(config.model === void 0 ? {} : { model: config.model }),
    command: config.command ?? "codebuddy",
    env: config.env ?? {},
    permissionMode: config.permissionMode ?? DEFAULT_CODEBUDDY_PERMISSION_MODE,
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
    startupTimeoutMs: config.startupTimeoutMs ?? DEFAULT_ACP_STARTUP_TIMEOUT_MS,
  };
  assertPositiveFinite("subagent-codebuddy", "disposeGraceMs", resolved.disposeGraceMs);
  assertPositiveFinite("subagent-codebuddy", "startupTimeoutMs", resolved.startupTimeoutMs);
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subagent-codebuddy: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  ctx.subagents.registerProvider(new CodeBuddyProvider(resolved.providerName, ctx, resolved));
}

export { Config, apply, inject, name };
