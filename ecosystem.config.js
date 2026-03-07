module.exports = {
  apps: [{
    name: 'reel-bot',
    script: './src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,
    kill_timeout: 10000,
    listen_timeout: 5000,
    exp_backoff_restart_delay: 1000,
    max_restarts: 10,
    min_uptime: '10s',
  }],
};
