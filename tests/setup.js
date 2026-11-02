import { join } from "node:path";

// Bun.spawnSync keeps the environment the process started with unless it is
// given one, so every spawn in the tests passes { env: process.env }.

process.env.JJ_CONFIG = join(import.meta.dir, "jj-config.toml");
