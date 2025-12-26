export const apps = [
  {
    name: 'telegram-transcribe-bot',
    script: './index.js',
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
    },
    log_date_format: 'YYYY-MM-DD HH:mm Z',
    error_file: './logs/error.log',
    out_file: './logs/output.log',
    merge_logs: true,
    node_args: '--no-network-family-autoselection',
  },
];
