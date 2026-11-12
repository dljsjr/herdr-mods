import { join } from "node:path";

// Bun.spawnSync keeps the environment the process started with unless it is
// given one, so every spawn in the tests passes { env: process.env }.

process.env.JJ_CONFIG = join(import.meta.dir, "jj-config.toml");
process.env.GIT_CONFIG_GLOBAL = join(import.meta.dir, "git-config");
process.env.GIT_CONFIG_NOSYSTEM = "1";
