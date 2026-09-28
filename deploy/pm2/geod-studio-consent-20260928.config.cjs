module.exports = {
  apps: [{
    name: "geod-studio-geod-consent-20260928",
    script: "/srv/laogao/releases/geod-studio/geod-oauth-consent-20260928-d408012d/web/server.js",
    cwd: "/srv/laogao/releases/geod-studio/geod-oauth-consent-20260928-d408012d/web",
    interpreter: "node",
    node_args: "--env-file=/srv/laogao/secrets/geod-studio.env",
    env: {
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: "9114",
      GEOD_RELEASE_ID: "geod-oauth-consent-20260928-d408012d",
      GEOD_IMAGE_RECOVERY_WORKER: "true",
      GEOD_STUDIO_DATA_DIR: "/srv/laogao/data/geod-studio/studio",
    },
    autorestart: true,
    min_uptime: "5s",
    max_restarts: 3,
  }],
};
