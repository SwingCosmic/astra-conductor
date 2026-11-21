import { homedir } from "node:os";
import path from "node:path";

/** Both GraphAgent launchers use the desktop app-data location unless explicitly overridden. */
export function graphProfileDirectory(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (override) return path.resolve(override);
  const home = homedir();
  let appData: string;
  if (process.platform === "win32") appData = env.APPDATA || path.join(home, "AppData", "Roaming");
  else if (process.platform === "darwin")
    appData = path.join(home, "Library", "Application Support");
  else appData = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(appData, "GraphAgent");
}
