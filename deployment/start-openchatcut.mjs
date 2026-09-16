import { startStandaloneServer } from "./server-dist/standalone.mjs";

const running = await startStandaloneServer();
console.log(`[OpenChatCut] production server listening on http://${running.host}:${running.port}`);

const close = (signal) => {
  console.log(`[OpenChatCut] received ${signal}; shutting down`);
  running.server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", close);
process.once("SIGTERM", close);
