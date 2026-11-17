import { fileURLToPath } from "node:url";
import { prepareSqliteNative } from "../../../scripts/prepare-sqlite-native.mjs";

await prepareSqliteNative(fileURLToPath(new URL("../", import.meta.url)));
