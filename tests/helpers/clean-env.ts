/** The environment for a command a test spawns: the test's own HOME, so nothing of the person's is read. */
export function cleanEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.HOME = home;
  env.XDG_DATA_HOME = `${home}/.local/share`;
  env.RESEARCH_WORKBENCH_CONFIG = "";
  delete env.WORKBENCH_PRIVATE_TERMS;
  return { ...env, ...extra };
}
