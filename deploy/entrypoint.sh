#!/bin/sh
# Create openclaw symlink so the agent can run `openclaw` commands
ln -sf /app/openclaw.mjs /usr/local/bin/openclaw 2>/dev/null || true

# Symlink skill wrapper scripts into /usr/local/bin so the agent can call them directly
for wrapper in /home/node/.openclaw/workspace/bin/*; do
  [ -f "$wrapper" ] && ln -sf "$wrapper" /usr/local/bin/"$(basename "$wrapper")" 2>/dev/null || true
done

# Move trades.db to native Linux filesystem to avoid SQLite locking issues on 9p bind mounts (Docker on Windows)
SIGNALS_DIR="/home/node/.openclaw/signals"
NATIVE_DIR="/home/node/signals-native"
if [ -f "$SIGNALS_DIR/trades.db" ] && [ ! -L "$SIGNALS_DIR/trades.db" ]; then
  mkdir -p "$NATIVE_DIR"
  cp "$SIGNALS_DIR/trades.db" "$NATIVE_DIR/trades.db"
  rm "$SIGNALS_DIR/trades.db"
  ln -s "$NATIVE_DIR/trades.db" "$SIGNALS_DIR/trades.db"
  chown -R node:node "$NATIVE_DIR"
elif [ ! -f "$SIGNALS_DIR/trades.db" ] && [ -f "$NATIVE_DIR/trades.db" ]; then
  ln -s "$NATIVE_DIR/trades.db" "$SIGNALS_DIR/trades.db"
fi

# Drop back to node user and start the gateway
exec su -s /bin/sh node -c "node /app/dist/index.js $*"
