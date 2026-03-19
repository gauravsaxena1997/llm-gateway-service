module.exports = {
  apps: [
    {
      name: 'llm-gateway-service',
      script: 'src/server.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx', // Using tsx to run directly
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
