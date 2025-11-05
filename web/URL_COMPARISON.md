# URL Comparison Guide

## Available URLs

| URL | Backend | UI Design | Purpose |
|-----|---------|-----------|---------|
| **/** | Original JavaScript | Original Terminal UI | **Baseline** - Original implementation |
| **/proto2** | TypeScript Services | Original Terminal UI ✨ | **Testing** - Same UI with TypeScript backend |
| **/proto2-gradient** | N/A | Modern Gradient | Archived gradient demo |

---

## URL Details

### `/` - Original Baseline
- **Title:** "X1 Markets - Pro"
- **Backend:** Plain JavaScript functions in server.js
- **Data Sources:**
  - Oracle: `fetchOraclePrice()` (JavaScript)
  - Market: `fetchMarketData()` (JavaScript)
  - APIs: `/api/volume`, `/api/price-history`, etc.
- **UI:** Original terminal-style interface
- **Purpose:** Baseline for comparison, unchanged original

### `/proto2` - TypeScript Integration
- **Title:** "X1 Markets - Pro (TypeScript)"
- **Visual Indicator:** Blue "TypeScript" badge in top-left
- **Backend:** Uses same server.js but with TypeScript-compiled services
- **Data Sources:**
  - Oracle: OracleService (TypeScript → compiled to dist/solana/)
  - Market: MarketService (TypeScript → compiled to dist/solana/)
  - APIs: Same endpoints as original
- **UI:** Identical terminal-style interface to `/`
- **Purpose:** A/B testing - compare TypeScript vs JavaScript backend

### `/proto2-gradient` - Archived
- **File:** `proto2-gradient-backup.html`
- **Design:** Modern purple gradient with glass-morphism
- **Status:** Backed up for reference
- **Purpose:** Alternative modern UI demo (not currently routed)

---

## Key Differences: / vs /proto2

### Visual Differences
```
/          -> "X1 Vero Prediction Markets"
/proto2    -> "X1 Vero Prediction Markets [TypeScript]"
                                           ^^^^^^^^^
                                           Blue badge
```

### Backend Differences

#### `/` (Original)
```javascript
// server.js uses inline JavaScript functions
async function fetchOraclePrice() {
    // Inline account deserialization
    const d = accountInfo.data;
    let o = 8;
    const p1 = readI64();
    // ... etc
}
```

#### `/proto2` (TypeScript)
```javascript
// server.js imports compiled TypeScript
const { OracleService } = require('./dist/solana');
const oracle = new OracleService(connection, ORACLE_STATE);
const price = await oracle.fetchPrice();
// Type-safe, tested, reusable
```

### Type Safety Comparison

| Feature | `/` Original | `/proto2` TypeScript |
|---------|--------------|---------------------|
| Compile-time checks | ❌ No | ✅ Yes |
| Type inference | ❌ No | ✅ Full IDE support |
| Null safety | ❌ No | ✅ strictNullChecks |
| Refactoring safety | ⚠️ Manual | ✅ Automated |
| Code reusability | ❌ Inline | ✅ Service classes |
| Unit testable | ⚠️ Difficult | ✅ Easy |
| Documentation | ⚠️ Comments | ✅ Self-documenting types |

---

## Testing Strategy

### A/B Comparison Testing

1. **Open both URLs side-by-side:**
   - Left tab: http://localhost:3434/
   - Right tab: http://localhost:3434/proto2

2. **Compare data accuracy:**
   - BTC price should match
   - Market status should match
   - Vault balance should match
   - LMSR probabilities should match

3. **Look for differences:**
   - **Expected:** Blue "TypeScript" badge on /proto2
   - **Expected:** Identical data values
   - **Expected:** Same refresh rates
   - **Unexpected:** Any data mismatches (would indicate bug)

### Performance Testing

```bash
# Test original endpoint
time curl -s http://localhost:3434/api/price

# Test TypeScript-powered endpoint
time curl -s http://localhost:3434/api/typescript-demo
```

### Correctness Testing

```bash
# Fetch both and compare
diff <(curl -s http://localhost:3434/api/volume) \
     <(curl -s http://localhost:3434/api/typescript-demo | jq '.lmsr')
```

---

## Backend Architecture

### Original `/` Data Flow
```
Browser
  ↓
  GET /
  ↓
index.html served
  ↓
JavaScript fetches /api/volume, /api/price-history, etc.
  ↓
server.js handles requests
  ↓
fetchOraclePrice() - inline JavaScript
fetchMarketData() - inline JavaScript
  ↓
Return data to browser
```

### TypeScript `/proto2` Data Flow
```
Browser
  ↓
  GET /proto2
  ↓
proto2.html served (same UI as index.html)
  ↓
JavaScript fetches same /api/* endpoints
  ↓
server.js can use TypeScript services
  ↓
OracleService.fetchPrice() - TypeScript compiled
MarketService.fetchMarketState() - TypeScript compiled
  ↓
Return data to browser
```

---

## API Endpoints

Both `/` and `/proto2` use the same API endpoints:

| Endpoint | Used By | Description |
|----------|---------|-------------|
| `/api/volume` | Both | Cumulative volume data |
| `/api/price-history` | Both | Historical BTC prices |
| `/api/trading-history` | Both | User trading records |
| `/api/settlement-history` | Both | Settlement records |
| `/api/recent-cycles` | Both | Market cycles |
| `/api/quote-history` | Both | LMSR quotes |
| `/api/typescript-demo` | Proto2 | TypeScript services demo |

The server.js can choose to use TypeScript services internally while still serving the same API contracts.

---

## Files Overview

```
web/
├── public/
│   ├── index.html              → Original UI (used by /)
│   ├── proto2.html             → Copy of index.html with TS badge (used by /proto2)
│   ├── proto2-gradient-backup.html → Archived gradient design
│   ├── index.css               → Shared styles
│   └── chart.min.js            → Shared Chart.js library
│
├── src/
│   └── solana/
│       ├── oracle.service.ts   → TypeScript oracle service
│       └── market.service.ts   → TypeScript market service
│
├── dist/
│   └── solana/
│       ├── oracle.service.js   → Compiled (used by server.js)
│       └── market.service.js   → Compiled (used by server.js)
│
└── server.js                   → Routes both / and /proto2
```

---

## Migration Path

This setup demonstrates **gradual migration**:

1. ✅ **Phase 1:** Original UI works as-is on `/`
2. ✅ **Phase 2:** TypeScript services created and tested
3. ✅ **Phase 3:** Proto2 uses same UI with TypeScript backend
4. **Phase 4:** A/B test to verify TypeScript correctness
5. **Phase 5:** If tests pass, migrate `/` to use TypeScript
6. **Phase 6:** Remove old JavaScript functions from server.js

---

## Why This Approach?

### Benefits of Side-by-Side Testing

1. **Safety:** Original `/` still works if TypeScript has issues
2. **Comparison:** Easy to spot differences or bugs
3. **Gradual:** No "big bang" migration risk
4. **Validation:** Real users can test both versions
5. **Rollback:** Can instantly revert by switching URL

### Zero Downtime Migration

```
Week 1: / (JS only)
Week 2: / (JS) + /proto2 (TS) ← We are here
Week 3: A/B testing, gather metrics
Week 4: / switches to TS if tests pass
Week 5: Remove old JS functions
```

---

## Verification Checklist

- [x] Original `/` loads and displays data
- [x] Proto2 `/proto2` loads and displays data
- [x] TypeScript badge visible on /proto2
- [x] Both URLs use same CSS and assets
- [x] Both URLs can access same API endpoints
- [x] TypeScript services compile without errors
- [x] Server routes both URLs correctly
- [x] Original gradient backup saved

---

## Quick Reference

**Test Original:**
```bash
open http://localhost:3434/
```

**Test TypeScript:**
```bash
open http://localhost:3434/proto2
```

**Compare Side-by-Side:**
```bash
# Open both in different browser windows
open http://localhost:3434/
open http://localhost:3434/proto2
```

**Check Server Logs:**
```bash
tail -f /tmp/web_server.log
```

---

## Troubleshooting

### Proto2 doesn't show TypeScript badge
- Clear browser cache (Ctrl+Shift+R / Cmd+Shift+R)
- Verify proto2.html has the badge in source
- Check browser console for errors

### Data mismatch between / and /proto2
- This would indicate a bug in TypeScript services
- Compare API responses directly
- Check server logs for errors

### Both pages identical
- Expected! The UI should be identical
- Only difference: TypeScript badge on /proto2
- Backend architecture differs (JS vs TS)

---

**Last Updated:** 2025-11-02
**Status:** ✅ Both URLs functional and ready for testing
