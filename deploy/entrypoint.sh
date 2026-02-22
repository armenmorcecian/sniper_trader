#!/bin/sh
# Create openclaw symlink so the agent can run `openclaw` commands
ln -sf /app/openclaw.mjs /usr/local/bin/openclaw 2>/dev/null || true

# Symlink skill wrapper scripts into /usr/local/bin so the agent can call them directly
for wrapper in /home/node/.openclaw/workspace/bin/*; do
  [ -f "$wrapper" ] && ln -sf "$wrapper" /usr/local/bin/"$(basename "$wrapper")" 2>/dev/null || true
done

# Drop back to node user and start the gateway
exec su -s /bin/sh node -c "node /app/dist/index.js $*"
