import {
  AUTONOMY_HELP,
  CONFIG_KEYS,
  isConfigKey,
  loadConfig,
  readConfigValue,
  saveConfig,
  setConfigValue,
} from "../core/config.js";
import { configPath } from "../core/paths.js";
import { paletteFor } from "../ui/ansi.js";

export function showConfig(): void {
  const palette = paletteFor(process.stdout);
  const config = loadConfig();
  console.log("");
  console.log(`  ${palette.dim(configPath())}`);
  console.log("");
  console.log(`  order      ${config.order.join(" → ")}`);
  console.log(
    `  autonomy   ${config.autonomy}  ${palette.dim(AUTONOMY_HELP[config.autonomy])}`,
  );
  console.log("");
  console.log(
    `  ${palette.dim(`change with`)} truss config set <${CONFIG_KEYS.join("|")}> <value>`,
  );
  console.log("");
}

export function getConfig(key: string): void {
  if (!isConfigKey(key)) {
    throw new Error(`unknown key "${key}" — known: ${CONFIG_KEYS.join(", ")}`);
  }
  console.log(readConfigValue(loadConfig(), key));
}

export function setConfig(key: string, value: string): void {
  if (!isConfigKey(key)) {
    throw new Error(`unknown key "${key}" — known: ${CONFIG_KEYS.join(", ")}`);
  }
  const next = setConfigValue(loadConfig(), key, value);
  saveConfig(next);
  const palette = paletteFor(process.stdout);
  console.log(
    `${palette.green("✓")} ${key} = ${readConfigValue(next, key)}${
      key === "autonomy" ? palette.dim(`  (${AUTONOMY_HELP[next.autonomy]})`) : ""
    }`,
  );
}
