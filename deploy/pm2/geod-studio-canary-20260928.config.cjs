module.exports = {
  apps: [
    {
      name: "geod-studio-oauth-canary-20260928",
      script: "/srv/laogao/releases/geod-studio/geod-oauth-20260928-65b5e65d/web/server.js",
      cwd: "/srv/laogao/releases/geod-studio/geod-oauth-20260928-65b5e65d/web",
      interpreter: "node",
      node_args: "--env-file=/srv/laogao/secrets/geod-studio.env",
      env: {
        NODE_ENV: "production",
        HOSTNAME: "127.0.0.1",
        PORT: "9116",
        GEOD_RELEASE_ID: "geod-oauth-canary-20260928-65b5e65d",
        GEOD_IMAGE_RECOVERY_WORKER: "false",
        GEOD_STUDIO_DATA_DIR: "/srv/laogao/data/geod-studio/studio",
      },
      autorestart: true,
      min_uptime: "5s",
      max_restarts: 3,
    },
  ],
};
