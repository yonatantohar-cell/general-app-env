/**
 * PM2 process definition — keeps the lead generator alive across crashes,
 * reboots and SSH disconnects.
 *
 *   pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: 'lead-gen',
      script: './index.js',
      cwd: __dirname,

      // One process only. Two would double-bill the API and race on leads.csv.
      instances: 1,
      exec_mode: 'fork',

      // The process is idle between cron fires, so any exit is abnormal.
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',

      // Back off instead of hot-looping if it dies on startup (e.g. bad API key).
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,

      // App-level logs still go to logs/run.log and logs/error.log; these
      // capture raw stdout/stderr, including anything PM2 itself reports.
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      time: true,

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
