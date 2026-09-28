import { createGatewayServer, readConfig } from "./server.mjs";

const config = readConfig();
createGatewayServer(config).listen(config.port, config.host, () => {
  process.stdout.write(`GeoD Agent model gateway listening on ${config.host}:${config.port}\n`);
});
