type DeploymentProvenance = {
  source?: string | null;
  marketInstall?: unknown;
  toolkitLinks?: readonly unknown[] | null;
};

export function isMarketManagedDeployment(deployment: DeploymentProvenance): boolean {
  return Boolean(deployment.marketInstall || deployment.toolkitLinks?.length);
}

export function usesDefaultRemoteRuntime(deployment: DeploymentProvenance): boolean {
  return deployment.source === 'remote' && !isMarketManagedDeployment(deployment);
}
