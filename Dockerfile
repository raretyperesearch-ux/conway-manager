FROM node:20-slim

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

WORKDIR /app

# Clone the real Conway automaton
RUN git clone https://github.com/Conway-Research/automaton.git .
RUN pnpm install
RUN pnpm build

# Copy our ALiFe wrapper that manages multiple agents
COPY manager.mjs /app/manager.mjs

EXPOSE 3001

# Default: run the manager (handles provisioning from ALiFe app)
# Override CMD to run a single automaton: node dist/index.js --run
CMD ["node", "manager.mjs"]
