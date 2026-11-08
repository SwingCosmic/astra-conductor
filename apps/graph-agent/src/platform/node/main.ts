import { startGraphServer } from "./start-server.js";

const server = await startGraphServer();
console.log(`GraphAgent Web: ${server.url}`);
const stop = () => {
  void server.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
