declare const MAIN_RUN_RECOVERY_EXECUTION_OWNER: unique symbol;

/** Opaque capability that scopes one exact recovery turn across deferred execution. */
export type MainRunRecoveryExecutionOwner = {
  readonly [MAIN_RUN_RECOVERY_EXECUTION_OWNER]: true;
  /** Stable operator identity used at transcript and other public metadata boundaries. */
  readonly publicRunId: string;
  start(params: { lifecycleGeneration: string }): Promise<void>;
};
