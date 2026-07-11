// Automatic startup work suppression shared by CLI boot policy and Gateway runtime owners.
export type GatewayStartupWorkSuppression = {
  reason: "crash-loop-breaker";
  message: string;
};
