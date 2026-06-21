// PM2 process file used by Colyseus Cloud (and `pm2 start` for self-hosting).
// Runs the compiled bundle produced by `npm run build` (esbuild → build/index.js).
// .listen() in src/index.ts binds the Cloud Unix socket / local port per instance.
module.exports = {
  apps: [
    {
      name: "blackout",
      script: "build/index.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--enable-source-maps",
      env: { NODE_ENV: "production" },
    },
  ],
};
