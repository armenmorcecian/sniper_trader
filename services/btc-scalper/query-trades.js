const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('/home/node/.openclaw/signals/trades.db');
const trades = db.prepare("SELECT * FROM trades WHERE metadata LIKE '%crypto-scalper%' AND pnl IS NOT NULL ORDER BY id DESC LIMIT 15").all();
console.log("=== RECENT SCALPER TRADES WITH P&L ===");
trades.forEach(t => {
  const m = JSON.parse(t.metadata || '{}');
  const ep = t.exit_price > 0 ? Number(t.exit_price).toFixed(3) : 'exit=' + t.exit_price;
  const pnlStr = '$' + Number(t.pnl).toFixed(3);
  const pnlPct = (t.exit_price > 0 && t.price > 0) ? ((t.exit_price - t.price) / t.price * 100).toFixed(1) + '%' : '?';
  console.log('#' + t.id + ' ' + t.side + ' ' + (m.asset||'?') + '/' + (m.timeframe||'?') + ' entry@' + Number(t.price).toFixed(3) + ' -> ' + ep + ' pnl=' + pnlStr + ' (' + pnlPct + ') ' + t.timestamp);
});
console.log("\n=== LAST 5 ALL TRADES ===");
const all = db.prepare("SELECT * FROM trades WHERE metadata LIKE '%crypto-scalper%' ORDER BY id DESC LIMIT 5").all();
all.forEach(t => {
  const m = JSON.parse(t.metadata || '{}');
  console.log('#' + t.id + ' ' + t.side + ' ' + (m.asset||'?') + '/' + (m.timeframe||'?') + ' entry@' + Number(t.price).toFixed(3) + ' exit_price_raw=' + t.exit_price + ' pnl_raw=' + t.pnl + ' ' + t.timestamp);
});
db.close();
